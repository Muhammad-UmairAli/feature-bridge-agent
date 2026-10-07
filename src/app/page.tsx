import Link from "next/link";

export default function Home() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">feature-bridge-agent</h1>
      <p className="text-muted-foreground">
        Request a feature, review the AI-generated plan, and preview the result.
      </p>
      <p>
        <Link href="/demos" className="text-primary underline underline-offset-4">
          Browse demos
        </Link>
      </p>
    </section>
  );
}
