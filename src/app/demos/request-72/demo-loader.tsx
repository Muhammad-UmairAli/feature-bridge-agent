"use client";

import dynamic from "next/dynamic";

// The demo runs in the browser only, never on the server.
const Demo = dynamic(() => import("./demo"), {
  ssr: false,
  loading: () => <p className="text-muted-foreground">Loading the demo...</p>,
});

export default function DemoLoader() {
  return <Demo />;
}
