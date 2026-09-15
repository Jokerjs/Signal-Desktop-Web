window.__MY_RENDER_CONFIG__ = Object.assign(
  {
    // The bridge serves both the page and its API from the same origin.
    apiBaseUrl: `${window.location.origin}/`,
    cdnBaseUrl: '',
    sfuUrl: '',
  },
  window.__MY_RENDER_CONFIG__ || {}
);
