// SCOUT extension runtime config — deployed defaults.
//
// This file is committed and always points at the production Azure service.
// To develop against a scout-service running on your own machine, copy
// config.local.example.js → config.local.js and edit it there. config.local.js
// is gitignored and is loaded *after* this file, so it wins.
//
// Both the service worker (importScripts) and extension pages (GET_CONFIG
// message to the worker) read from this single object.
self.SCOUT_CONFIG = {
  // Backend origin. No trailing slash.
  BASE_URL: "https://scout-service.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io",

  // Shared secret for the Scout backend endpoints (the extension has no
  // Microsoft SSO token). Sent as X-Scout-Key on every Scout API call.
  // Must match SCOUT_API_KEY on whichever server BASE_URL points at.
  SCOUT_KEY: "scout_a5ThvEKUjRbZmlpDyKQOF9WcKb2fiEl8Vat-8f_3Bzg",
};
