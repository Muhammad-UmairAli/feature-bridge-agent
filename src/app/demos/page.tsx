import type { Metadata } from "next";

export const metadata: Metadata = { title: "Demos" };

export default function DemosIndex() {
  return (
    <main>
      <h1>Demos</h1>
      <p>Features built from approved requests appear here. There are none yet.</p>
    </main>
  );
}
