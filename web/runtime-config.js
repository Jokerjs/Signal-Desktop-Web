window.__MY_RENDER_CONFIG__ = Object.assign(
  {
    apiBaseUrl: `http://${window.location.hostname || '127.0.0.1'}:3100`,
    cdnBaseUrl: '',
    sfuUrl: '',
  },
  window.__MY_RENDER_CONFIG__ || {}
);
