module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  extends: ["eslint:recommended"],
  ignorePatterns: ["dist", "neryva-mcp-contract/gen", "node_modules"],
  rules: {},
};
