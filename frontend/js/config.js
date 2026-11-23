const pageLocation = window.location;
const apiBase = pageLocation.protocol === "file:"
  ? "http://127.0.0.1:5000/api"
  : (pageLocation.port === "5000" || pageLocation.port === "" || pageLocation.port === "8080" || pageLocation.protocol === "https:")
    ? (window.location.origin && window.location.origin !== "null"
        ? window.location.origin + "/api"
        : `${pageLocation.protocol}//${pageLocation.hostname || "127.0.0.1"}:5000/api`)
    : (pageLocation.port === "5500" || pageLocation.port === "3000")
      ? `${pageLocation.protocol}//${pageLocation.hostname || "127.0.0.1"}:5000/api`
      : (window.location.origin && window.location.origin !== "null"
          ? window.location.origin + "/api"
          : `${pageLocation.protocol}//${pageLocation.hostname || "127.0.0.1"}:5000/api`);

window.APP_CONFIG = { apiBase };
