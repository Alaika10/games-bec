import { defineConfig } from "eslint/config";
import next from "eslint-config-next";
import firebaseRulesPlugin from "@firebase/eslint-plugin-security-rules";

export default defineConfig([
  {
    ignores: [".next/**/*", "dist/**/*", "node_modules/**/*"],
  },
  ...next,
  firebaseRulesPlugin.configs["flat/recommended"],
]);
