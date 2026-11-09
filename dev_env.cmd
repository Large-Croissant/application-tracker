@echo off
rem Runs any command inside the Visual Studio developer environment
rem (required because rustc cannot auto-discover the VS 18 C++ toolchain).
rem VsDevCmd is used because this install lacks vcvarsall.bat.
call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 -no_logo >nul 2>&1
if errorlevel 1 (
    echo Failed to initialize the Visual Studio environment.
    exit /b 1
)
cmd /c %*
