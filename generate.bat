C:\tools\nanopb\generator-bin\protoc --nanopb_out=X:\source\wobble\wobble_esp32_gd2\ --proto_path=C:\tools\nanopb\generator\proto\ --proto_path=X:\source\wobble wobble_protocol.proto
C:\tools\nanopb\generator-bin\protoc --nanopb_out=X:\source\wobble\wobble_esp8266_lis3dhh\ --proto_path=C:\tools\nanopb\generator\proto\ --proto_path=X:\source\wobble wobble_protocol.proto
cd wobble_server
rem wsl npm install protobufjs --save
wsl node_modules/.bin/pbjs ../wobble_protocol.proto -o wobble_protocol.json
cd ..