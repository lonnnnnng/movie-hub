$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$scriptDir/deploy.mjs" @args
exit $LASTEXITCODE
