import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>feature-bridge-agent</h1>
      <p>Request a feature, review the AI-generated plan, and preview the result.</p>
      <p>
        <Link href="/demos">Browse demos</Link>
      </p>
    </main>
  );
}
