window.__MY_RENDER_CONFIG__ = Object.assign(
  {
    // Empty apiBaseUrl means the browser will use the current origin.
    // With Nginx/Caddy proxying bridge endpoints on the same domain, this avoids CORS.
    apiBaseUrl: "",
    cdnBaseUrl: "",
    sfuUrl: ""
  },
  window.__MY_RENDER_CONFIG__ || {}
);
