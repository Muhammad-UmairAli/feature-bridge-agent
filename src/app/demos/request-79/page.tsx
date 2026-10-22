import type { Metadata } from "next";

import DemoLoader from "./demo-loader";

export const metadata: Metadata = { title: "Interactive counter demo" };

export default function Page() {
  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Interactive counter demo</h1>
      <DemoLoader />
    </section>
  );
}
