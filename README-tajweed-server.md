# Tajweed server — run it, then open the app from the SAME origin

1. Enable **Cloud Speech-to-Text API** in your Google Cloud project.
2. Set the key (the browser NEVER sees it):
   export GOOGLE_CLOUD_SPEECH_API_KEY="your-key"
   # or: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
   #      export GOOGLE_ACCESS_TOKEN="$(gcloud auth application-default print-access-token)"
3. (Optional, for MFA timings) install Montreal Forced Aligner on this machine:
   conda create -n aligner -c conda-forge montreal-forced-aligner
   Without it the server returns mfaAvailable=false and the app marks words
   "not verified" instead of faking MFA timings.
4. Put server.js, index.html and sw.js in the SAME folder, then:
   node server.js
5. Open http://localhost:3000  (same origin, so /api/tajweed-check works).
   Check: http://localhost:3000/api/health — googleConfigured must be true.

If the key is missing, POST /api/tajweed-check returns 503 and the app shows
"Server not connected". That is deliberate: no timings are ever faked.
