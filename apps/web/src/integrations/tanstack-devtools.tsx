import { TanStackDevtools } from "@tanstack/react-devtools";
import { TanStackRouterDevtoolsPanelInProd } from "@tanstack/react-router-devtools";

import TanStackQueryDevtools from "./tanstack-query/devtools";

export default function TanStackDevtoolsMount() {
  return (
    <TanStackDevtools
      config={{
        position: "bottom-right",
        openHotkey: [],
      }}
      plugins={[
        {
          name: "Tanstack Router",
          render: <TanStackRouterDevtoolsPanelInProd />,
        },
        TanStackQueryDevtools,
      ]}
    />
  );
}
