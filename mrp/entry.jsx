// Browser entry point for the MRP module on Vercel.
//
// The MRP console was authored as a Claude artifact: a single default-exported
// <App/> that the artifact host mounted for it. Here we mount it ourselves with
// React 18. The window.storage shim (see mrp/index.html) must already be defined
// before this bundle runs — App reads/writes its data through it.

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./mrp-console.jsx";

const el = document.getElementById("root");
createRoot(el).render(React.createElement(App));
