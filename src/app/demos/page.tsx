import type { Metadata } from "next";

export const metadata: Metadata = { title: "Demos" };

export default function DemosIndex() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Demos</h1>
      <p className="text-muted-foreground">
        Features built from approved requests appear here. There are none yet.
      </p>
    </section>
  );
}
