const features = [
  ["Local Proxy", "Give agents a safe local target instead of production APIs."],
  ["Provider-Shaped Responses", "Return realistic success and failure payloads that look like the providers your app already uses."],
  ["MCP For Agents", "Let agents inspect state, read logs, force responses, and toggle failure modes instead of guessing what happened.", "ghostapi mcp"],
  ["Scenarios", "Turn common integration flows into repeatable fixtures: payment failure, email send, issue creation, and custom traffic saved from your own app."],
  ["Chaos Mode", "Break the happy path on purpose with rate limits, upstream failures, and latency so retry logic actually gets tested."],
  ["Live Dashboard", "See the agent's API world in real time: every call, every response, every replay, every override."]
] as const;

const steps = [
  ["Start GhostAPI", "npx ghostapi start --open", "GhostAPI runs locally and opens the dashboard."],
  ["Point Your App At Localhost", "http://127.0.0.1:8080", "GhostAPI detects providers like Stripe, Twilio, Resend, GitHub, Discord, OpenAI, and generic REST APIs."],
  ["Inspect, Replay, And Let Agents Control It", "request -> failure -> dashboard -> MCP/control -> replay -> generated test", "Use the dashboard and MCP tools to turn local traffic into repeatable agent workflows."]
] as const;

const audiences = [
  ["AI Coding Agents", "Give coding agents a safe local API world to inspect, replay, and control."],
  ["SaaS Developers", "Build third-party integrations without risking production data or external side effects."],
  ["API-Heavy Teams", "Create repeatable local scenarios, generate tests from traffic, and keep integration development safe and observable."]
] as const;

const installs = [
  ["Start Instantly", "npx ghostapi start --open"],
  ["Install Globally", "npm install -g ghostapi\nghostapi start --open"],
  ["Start MCP", "ghostapi mcp"],
  ["Generate Agent Setup", "ghostapi setup --write"]
] as const;

const faqs = [
  ["Is GhostAPI a mock server?", "It includes mock behavior, but the bigger idea is a local API world for agents: provider-shaped responses, scenarios, dashboard inspection, MCP control, generated tests, and safety checks."],
  ["Does GhostAPI call real provider APIs?", "No. GhostAPI is local-first and does not call real providers by default."],
  ["Does it require an LLM key?", "No. GhostAPI works with deterministic local mocks. Optional AI generation can be added, but local fallback is always available."],
  ["Which providers are supported?", "Stripe, Twilio, Resend, GitHub, Discord, OpenAI, and generic REST APIs."],
  ["Which agents does it work with?", "GhostAPI works with MCP-compatible clients and provides setup snippets/instructions for Claude, Cursor, Cline, Aider, Codex, OpenCode, Gemini CLI, Goose, OpenClaw, Hermes Desktop, and generic stdio MCP clients."],
  ["Is it open source?", "Yes. GhostAPI is designed as an open-source local developer tool under the MIT license."]
] as const;

function IconMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 12C6 5.9 10.8 2 16 2s10 3.9 10 10v12.7c0 2-2.4 3-3.8 1.6l-1.7-1.7-2 2-2.5-2.4-2.5 2.4-2-2-1.7 1.7C8.4 27.7 6 26.7 6 24.7V12Z" />
      <circle cx="12.4" cy="13.4" r="1.8" />
      <circle cx="19.6" cy="13.4" r="1.8" />
    </svg>
  );
}

function Button({ children, href, variant = "primary" }: { children: string; href: string; variant?: "primary" | "ghost" }) {
  return <a className={`btn btn-${variant}`} href={href}>{children}</a>;
}

function Code({ children }: { children: string }) {
  return <pre className="code"><code>{children}</code></pre>;
}

function ProductVisual() {
  return (
    <div className="product-visual" aria-label="GhostAPI product moment">
      <div className="visual-topline">
        <span>localhost:8080</span>
        <span className="live-dot">live</span>
      </div>
      <div className="visual-grid">
        <div className="traffic-panel panel">
          <span className="panel-label">Live Traffic</span>
          <div className="request active"><span>POST</span><strong>/v1/payment_intents</strong><em>stripe</em></div>
          <div className="request"><span>POST</span><strong>/v1/chat/completions</strong><em>openai</em></div>
          <div className="request"><span>POST</span><strong>/messages</strong><em>twilio</em></div>
        </div>
        <div className="failure-panel panel">
          <span className="panel-label">Replayed Stripe Failure</span>
          <Code>{`{
  "error": {
    "type": "card_error",
    "code": "card_declined"
  }
}`}</Code>
        </div>
        <div className="control-panel panel">
          <span className="panel-label">Agent Setup / MCP Controls</span>
          <div className="control-row"><span>inspect_state</span><b>ready</b></div>
          <div className="control-row"><span>set_api_behavior</span><b>forced</b></div>
          <div className="control-row"><span>toggle_chaos_mode</span><b>off</b></div>
        </div>
      </div>
      <p>Run GhostAPI locally. Watch every API call. Replay scenarios. Let agents control behavior through MCP.</p>
    </div>
  );
}

export function App() {
  return (
    <div className="site-shell">
      <header className="nav">
        <a className="brand" href="#top" aria-label="GhostAPI home"><IconMark /><span>GhostAPI</span></a>
        <nav className="nav-links" aria-label="Primary navigation">
          <a href="#problem">Problem</a>
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#install">Install</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-actions">
          <a className="stars-pill" href="https://github.com/ghostapi/ghostapi">GitHub</a>
          <Button href="https://github.com/ghostapi/ghostapi" variant="ghost">View on GitHub</Button>
          <Button href="#install">Get Started</Button>
        </div>
      </header>

      <main id="top">
        <section className="hero section">
          <a className="announcement" href="#proof">From one unsafe API call to a replayable local scenario in under a minute <span>›</span></a>
          <h1>The local internet for <span>AI coding agents.</span></h1>
          <p className="hero-subline">Build, test, and replay third-party API integrations locally without touching production services, leaking real keys, sending real messages, or charging real cards.</p>
          <div className="hero-actions">
            <Button href="#install">Get Started</Button>
            <Button href="https://github.com/ghostapi/ghostapi" variant="ghost">View on GitHub</Button>
          </div>
          <div className="hero-command"><Code>npx ghostapi start --open</Code></div>
          <ProductVisual />
          <p className="killer-use-case">Cursor writes a Stripe integration. GhostAPI catches the request, returns a realistic payment failure, and the agent fixes the code without ever touching production.</p>
        </section>

        <section className="problem section" id="problem">
          <div className="section-copy">
            <span className="eyebrow">Problem</span>
            <h2>AI agents are writing integration code, but production APIs are the wrong place to test it.</h2>
          </div>
          <div className="problem-grid">
            <article>Real provider calls can charge cards, send emails, post messages, mutate repos, or spend API credits.</article>
            <article>Live APIs are slow, flaky, rate-limited, and unsafe for autonomous coding loops.</article>
            <article>Hand-written mocks are brittle, shallow, and hard to keep realistic.</article>
          </div>
        </section>

        <section className="section" id="how">
          <div className="section-copy centered">
            <span className="eyebrow">How It Works</span>
            <h2>Start local, route to localhost, then inspect, replay, and control.</h2>
          </div>
          <div className="steps-grid">
            {steps.map(([title, command, body], index) => (
              <article className="step-card" key={title}>
                <span className="step-number">0{index + 1}</span>
                <h3>{title}</h3>
                <Code>{command}</Code>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section" id="features">
          <div className="section-copy centered">
            <span className="eyebrow">Core Features</span>
            <h2>Everything on the homepage stays focused on the local API control loop.</h2>
          </div>
          <div className="feature-grid">
            {features.map(([title, body, command]) => (
              <article className="feature-card" key={title}>
                <div className="feature-icon"><IconMark /></div>
                <h3>{title}</h3>
                <p>{body}</p>
                <div className="line-art"><span /><span /><span /></div>
                {command ? <Code>{command}</Code> : null}
              </article>
            ))}
          </div>
        </section>

        <section className="section audience-section">
          <div className="section-copy">
            <span className="eyebrow">Who It's For</span>
            <h2>Built for agents, developers, and teams shipping API-heavy products.</h2>
          </div>
          <div className="audience-grid">
            {audiences.map(([title, body]) => <article key={title}><h3>{title}</h3><p>{body}</p></article>)}
          </div>
        </section>

        <section className="section install-section" id="install">
          <div className="section-copy centered">
            <span className="eyebrow">Installation</span>
            <h2>Start instantly, install globally, start MCP, or generate agent setup.</h2>
          </div>
          <div className="install-grid">
            {installs.map(([title, command]) => <article className="install-card" key={title}><h3>{title}</h3><Code>{command}</Code></article>)}
          </div>
          <p className="install-note">This generates agent instructions and MCP snippets without overwriting existing files.</p>
        </section>

        <section className="section proof-section" id="proof">
          <div className="proof-card">
            <div className="section-copy">
              <span className="eyebrow">Proof / Screenshot / GIF</span>
              <h2>request → failure → dashboard → MCP/control → replay → generated test</h2>
              <p>The homepage should not only claim the product works; it should show the full control loop.</p>
            </div>
            <div className="storyboard">
              {[
                "npx ghostapi start --open",
                "dashboard opens",
                "Cursor or another agent writes/calls a Stripe integration",
                "a request appears in live traffic",
                "GhostAPI returns a realistic payment failure",
                "the failure is visible in the dashboard",
                "MCP/control action or scenario replay is triggered",
                "the same failure is replayed deterministically",
                "a test is generated from the captured traffic"
              ].map((item) => <span key={item}>{item}</span>)}
            </div>
          </div>
        </section>

        <section className="section faq-section" id="faq">
          <div className="section-copy centered">
            <span className="eyebrow">FAQ</span>
            <h2>Local-first, deterministic, and open source.</h2>
          </div>
          <div className="faq-grid">
            {faqs.map(([question, answer]) => <article key={question}><h3>{question}</h3><p>{answer}</p></article>)}
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="brand"><IconMark /><span>GhostAPI</span></div>
        <p>GhostAPI is the local internet for AI coding agents.</p>
        <Button href="#install">Get Started</Button>
      </footer>
    </div>
  );
}
