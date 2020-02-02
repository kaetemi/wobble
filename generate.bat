C:\tools\nanopb\generator-bin\protoc --nanopb_out=X:\source\wobble\wobble_esp32_gd2\ --proto_path=C:\tools\nanopb\generator\proto\ --proto_path=X:\source\wobble wobble_protocol.proto
rem wsl sudo npm install -g protobufjs
rem wsl sudo npm install -g semver
cd wobble_server
wsl node_modules/.bin/pbjs ../wobble_protocol.proto -o wobble_protocol.json
