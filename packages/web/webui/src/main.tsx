import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AntdRoot } from "./ui/AntdRoot.tsx";
import "antd/dist/reset.css";
import "./styles/app.css";
import "./styles/design-system.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<AntdRoot>
			<App />
		</AntdRoot>
	</StrictMode>,
);
