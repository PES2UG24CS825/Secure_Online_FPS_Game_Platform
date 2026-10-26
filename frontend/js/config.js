const pageLocation = window.location;
const apiBase = pageLocation.protocol === "file:"
  ? "http://127.0.0.1:5000/api"
  : pageLocation.port === "5000"
    ? window.location.origin + "/api"
    : `${pageLocation.protocol}//${pageLocation.hostname || "127.0.0.1"}:5000/api`;

window.APP_CONFIG = { apiBase };
