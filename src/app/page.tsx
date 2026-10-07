import Link from "next/link";

import { RequestForm } from "@/components/request-form";

export default function Home() {
  return (
    <section className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Request a feature</h1>
        <p className="text-muted-foreground">
          Describe a feature you&apos;d like to see. An AI agent drafts a plan, a maintainer reviews
          it, and approved features are built with tests and a preview you can try.
        </p>
        <p>
          <Link href="/demos" className="text-primary underline underline-offset-4">
            Browse demos
          </Link>
        </p>
      </header>
      <RequestForm />
    </section>
  );
}
