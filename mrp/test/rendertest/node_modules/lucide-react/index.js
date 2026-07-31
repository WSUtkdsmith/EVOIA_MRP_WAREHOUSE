// Stub for lucide-react, used only by the render suite.
// Every icon renders as an empty span, so the render tests need no real
// icon dependency and no network access.
const React = require('react');
const icon = (name) => (props) => React.createElement('span', { 'data-icon': name });
module.exports = new Proxy({}, {
  get: (t, k) => (k === '__esModule' ? true : icon(String(k)))
});
