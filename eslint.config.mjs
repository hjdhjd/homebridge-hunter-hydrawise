/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "homebridge-plugin-utils/eslint";

/* The preset carries the test-file relaxations itself: its tests option defaults to the family's test, fixture, and helper naming, so the co-located suites under
 * src/ lint under the same strict rules as production apart from the idioms the preset admits for them, such as a node:test registration call left unawaited.
 */
export default hbPluginUtils({

  // These are the JS and config files that sit outside the main TypeScript project, so the parser needs its default-project fallback to lint them at all.
  allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)", "homebridge-ui/public/lib/*.@(js|mjs)" ],
  js: [ "homebridge-ui/public/**/*.@(js|mjs)", "homebridge-ui/server.js", "eslint.config.mjs" ],

  // server.js runs under Node and calls fetch directly, so it lints with Node's globals, while the browser-side modules keep only the browser's.
  node: ["homebridge-ui/server.js"],
  ts: ["src/**/*.ts"],
  ui: ["homebridge-ui/public/ui.mjs"]
});
