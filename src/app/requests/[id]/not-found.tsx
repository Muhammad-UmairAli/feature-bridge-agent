import Link from "next/link";

export default function RequestNotFound() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Request not found</h1>
      <p className="text-muted-foreground">
        There&apos;s no request with that number. Check the tracking link you were given.
      </p>
      <p>
        <Link href="/" className="text-primary underline underline-offset-4">
          Submit a new request
        </Link>
      </p>
    </section>
  );
}
