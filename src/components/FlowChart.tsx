import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { sankey, sankeyJustify, sankeyLinkHorizontal } from "d3-sankey";
import {
  STATUSES,
  type Application,
  type ApplicationEvent,
  type Status,
} from "../types";

interface Props {
  applications: Application[];
}

/** Fixed viewBox of the diagram; scales to the panel width. */
const W = 940;
const H = 460;
const NODE_WIDTH = 11;
/** Gutter each side of the bars, reserved for node labels. */
const LABEL_GUTTER = 112;

/** Forward-only pipeline order. The flowchart tells the forward story:
 * back-transitions (fixing a mistake by hand) live in the timeline, not here —
 * and filtering to strictly-forward steps makes the graph acyclic for sure. */
const RANK: Record<string, number> = {
  sent: 0,
  wishlist: 0,
  applied: 1,
  acknowledged: 2,
  interviewing: 3,
  offer: 4,
  accepted: 5,
  rejected: 5,
  ghosted: 5,
  withdrawn: 5,
};

/** SVG paints fills, not classes — hex twins of the tailwind status dots. */
const STATUS_HEX: Record<string, string> = {
  wishlist: "#a78bfa",
  applied: "#38bdf8",
  acknowledged: "#22d3ee",
  interviewing: "#fbbf24",
  offer: "#34d399",
  accepted: "#4ade80",
  rejected: "#f87171",
  ghosted: "#94a3b8",
  withdrawn: "#a1a1aa",
};

function statusLabel(status: string): string {
  return STATUSES.find((s) => s.value === status)?.label ?? status;
}

function known(status: string): boolean {
  return status in STATUS_HEX;
}

interface FlowNode {
  id: string;
}
interface FlowLink {
  source: string;
  target: string;
  value: number;
}

/** Whether the backend already wrote this pair as a status_change note. */
const ARROW = " → ";

/**
 * Rebuilds each application's path through the pipeline from its recorded
 * status_change events, then aggregates transitions into Sankey links.
 * A "Sent" source node feeds every app's first recorded stage; apps that
 * never moved show up as mass resting on their current node (leftover bar
 * height), like Flosa's "No update" but without a fake extra node.
 */
function buildAggregate(
  applications: Application[],
  events: ApplicationEvent[],
): { nodes: FlowNode[]; links: FlowLink[] } {
  const byApp = new Map<number, ApplicationEvent[]>();
  for (const ev of events) {
    const list = byApp.get(ev.applicationId);
    if (list) list.push(ev);
    else byApp.set(ev.applicationId, [ev]);
  }

  const sentApps = applications.filter((a) => a.status !== "wishlist");
  const linkCount = new Map<string, number>();

  function addLink(from: string, to: string) {
    if (from === to) return;
    const key = `${from}|${to}`;
    linkCount.set(key, (linkCount.get(key) ?? 0) + 1);
  }

  for (const app of sentApps) {
    const transitions = (byApp.get(app.id) ?? [])
      .sort((a, b) =>
        a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id - b.id,
      )
      .filter((e) => e.kind === "status_change")
      .map((e) => {
        const parts = e.note.split(ARROW);
        if (parts.length !== 2) return null;
        const from = parts[0].trim();
        const to = parts[1].trim();
        if (!known(from) || !known(to) || from === to) return null;
        return [from, to] as [string, string];
      })
      .filter((t): t is [string, string] => t !== null);

    let last = ""; // last stage the app demonstrably reached
    for (const [from, to] of transitions) {
      if (from === "wishlist" || to === "wishlist") continue;
      // Strictly-forward moves only — corrections are timeline material.
      if (!(RANK[from] < RANK[to])) continue;
      if (!last) addLink("sent", from); // every app enters from the source
      if (last && RANK[from] > RANK[last]) addLink(last, from); // bridging data gaps
      addLink(from, to);
      last = to;
    }

    const current = app.status as Status;
    if (!last) {
      // No recorded movement — the app rests where it currently is, fed
      // straight from the source (Applied's leftover height = these).
      addLink("sent", current);
    } else if (last !== current && known(current)) {
      addLink(last, current); // late current-state sync (manual status changes)
    }
  }

  // Node set = source + every referenced status.
  const nodeIds = new Set<string>(["sent"]);
  for (const key of linkCount.keys()) {
    const [from, to] = key.split("|");
    nodeIds.add(from);
    nodeIds.add(to);
  }
  const nodes: FlowNode[] = [...nodeIds].map((id) => ({ id }));
  const links: FlowLink[] = [...linkCount.entries()].map(([key, value]) => {
    const [source, target] = key.split("|");
    return { source, target, value };
  });

  return { nodes, links };
}

/** Sankey "flowchart" of how applications moved through the pipeline,
 * derived from recorded status_change history. */
export default function FlowChart({ applications }: Props) {
  const [events, setEvents] = useState<ApplicationEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listAllEvents()
      .then((all) => {
        if (!cancelled) setEvents(all);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const drawn = useMemo(() => {
    if (events === null) return null;
    const aggregate = buildAggregate(applications, events);
    // A diagram needs movement: more than the source feeding one node.
    if (aggregate.links.length < 2) return null;
    // Monotone forward filtering guarantees an acyclic graph, so the layout
    // can't throw on cycles like an unfiltered history could. d3-sankey's
    // default nodeId accessor is the array index — ours is the `id` field,
    // which is how links (strings) resolve to nodes (objects).
    const generator = sankey<FlowNode, FlowLink>()
      .nodeId((n) => n.id)
      .nodeWidth(NODE_WIDTH)
      .nodePadding(18)
      .nodeAlign(sankeyJustify)
      // Left/right gutters reserved for the node labels, so nothing draws
      // outside the viewBox (the "cut off" edges came from that).
      .extent([
        [LABEL_GUTTER, 14],
        [W - LABEL_GUTTER, H - 24],
      ]);
    try {
      return generator({
        nodes: aggregate.nodes.map((n) => ({ ...n })),
        links: aggregate.links.map((l) => ({ ...l })),
      } as never) as ReturnType<ReturnType<typeof sankey<FlowNode, FlowLink>>>;
    } catch {
      // Belt and suspenders: any layout surprise degrades to a calm note,
      // never a blank tab.
      return "layout-error" as const;
    }
  }, [applications, events]);

  if (error) {
    return <p className="text-sm text-red-300">Could not load flow data: {error}</p>;
  }
  if (events === null || drawn === null) {
    return (
      <p className="text-sm text-zinc-600">
        {events === null
          ? "Loading flow…"
          : "Flow appears once applications start moving — every status change is a ribbon."}
      </p>
    );
  }
  if (drawn === "layout-error") {
    return (
      <p className="text-sm text-zinc-600">
        Flow skipped — this history produced a diagram the layout can't draw cleanly.
      </p>
    );
  }

  const { nodes, links } = drawn as {
    nodes: (FlowNode & { x0: number; x1: number; y0: number; y1: number; value: number })[];
    links: (FlowLink & { width: number; y0: number; y1: number })[];
  };
  const linkPath = sankeyLinkHorizontal<FlowNode, FlowLink>();

  return (
    <div className="h-[clamp(240px,48vh,470px)] w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full select-none"
        role="img"
      >
        {/* Ribbons */}
        {links.map((link, i) => {
          const src = link.source as unknown as (FlowNode & { x0: number });
          const color = STATUS_HEX[(src as { id: string }).id] ?? "#71717a";
          return (
            <path
              key={i}
              d={linkPath(link) ?? ""}
              fill="none"
              stroke={color}
              strokeOpacity={0.22}
              strokeWidth={Math.max(1, link.width)}
            >
              <title>
                {statusLabel((link.source as unknown as FlowNode).id)} →{" "}
                {statusLabel((link.target as unknown as FlowNode).id)}: {link.value}
              </title>
            </path>
          );
        })}

        {/* Node bars */}
        {nodes.map((node, i) => {
          const color = STATUS_HEX[node.id] ?? "#71717a";
          // Inside the viewBox everything — chart AND labels — lives between
          // the gutters, so the reserved label room scales with the whole
          // drawing instead of clipping at the edges.
          const leftColumn = node.x0 < LABEL_GUTTER + NODE_WIDTH;
          return (
            <g key={i}>
              <rect
                x={node.x0}
                y={node.y0}
                width={NODE_WIDTH}
                height={Math.max(2, node.y1 - node.y0)}
                rx={3}
                fill={color}
              >
                <title>{`${statusLabel(node.id)} · ${node.value} total`}</title>
              </rect>
              <text
                x={leftColumn ? node.x0 - 6 : node.x1 + 6}
                y={(node.y0 + node.y1) / 2}
                dy="0.35em"
                textAnchor={leftColumn ? "end" : "start"}
                className="fill-zinc-300"
                fontSize={13}
              >
                {node.id === "sent"
                  ? `All ${node.value}`
                  : `${statusLabel(node.id)} ${node.value}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
