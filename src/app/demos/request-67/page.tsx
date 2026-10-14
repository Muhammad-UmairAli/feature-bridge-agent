import type { Metadata } from "next";

import DemoLoader from "./demo-loader";

export const metadata: Metadata = { title: "Simple Counter with Increment Decrement Buttons" };

export default function Page() {
  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Simple Counter with Increment Decrement Buttons</h1>
      <DemoLoader />
    </section>
  );
}
