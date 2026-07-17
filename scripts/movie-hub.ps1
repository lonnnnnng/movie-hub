$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$scriptDir/service.mjs" @args
exit $LASTEXITCODE
