// This fixture deliberately represents unsafe application behavior. Only run it through ghostapi run.
await fetch("https://api.stripe.com/v1/customers", { signal: AbortSignal.timeout(5_000) });
