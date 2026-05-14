# OBS / Gladia

## Setup

- install OBS
- install sox: https://github.com/gillesdemey/node-record-lpcm16#dependencies
- copy the .env.sample to create a .env file
- run `npm run list-audio-devices` to identify the device to record
- put the device name to .env in the AUDIO_DEVICE key
- grab a Gladia API and put it to your .env file
- run server `npm run start`
- add to OBS a web view targeting `http://localhost:8080`
- now you should see the transcription
