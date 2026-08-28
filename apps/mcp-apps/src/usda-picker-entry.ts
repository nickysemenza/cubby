import { App } from "@modelcontextprotocol/ext-apps";
import "./app.css";
import { connectUsdaPicker } from "./usda-picker";

const app = new App({ name: "Cubby USDA Picker", version: "1.0.0" });

void connectUsdaPicker(app);
