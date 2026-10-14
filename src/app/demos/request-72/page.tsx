import type { Metadata } from "next";

import DemoLoader from "./demo-loader";

export const metadata: Metadata = { title: "Counter with increment and decrement buttons" };

export default function Page() {
  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Counter with increment and decrement buttons</h1>
      <DemoLoader />
    </section>
  );
}
