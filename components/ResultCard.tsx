"use client";

import { useState } from "react";
import { ContextBundle, Sourced, SourceTag } from "@/lib/types";

function Tags({ sources }: { sources?: SourceTag[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <span className="tags">
      {sources.map((s) => (
        <span key={s} className={`tag ${s}`}>
          {s}
        </span>
      ))}
    </span>
  );
}

function LinkChip({ label, link }: { label: string; link?: Sourced }) {
  const has = link && link.value && link.sources[0] !== "unknown";
  return (
    <div className="link-chip">
      <span className="label">{label}</span>
      {has ? (
        <a href={link!.value} target="_blank" rel="noreferrer">
          Open ↗
        </a>
      ) : (
        <span className="absent">not on file</span>
      )}
    </div>
  );
}

export default function ResultCard({ bundle }: { bundle: ContextBundle }) {
  const [open, setOpen] = useState(false);
  const b = bundle;
  const regimeLabel =
    b.regime === "past"
      ? "Past meeting — full history"
      : `Upcoming meeting${b.meetingDate ? ` (${b.meetingDate})` : ""} — prep`;

  return (
    <div className="card">
      {/* ---- Head ---- */}
      <div className="card-head">
        <div className="title-row">
          <div>
            <h2>
              {b.company}
              {b.founder && !b.company.includes(b.founder) ? ` · ${b.founder}` : ""}
            </h2>
            <div className="meta">
              Generated {b.generated} · Sources: {b.sourcesChecked.join(" · ")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {b.identity.pipelineStatus?.value && (
              <span className="pill status">{b.identity.pipelineStatus.value}</span>
            )}
            <span className="pill regime">{regimeLabel}</span>
          </div>
        </div>
      </div>

      {/* ---- Summary ---- */}
      <div className="card-summary">{b.summary}</div>

      {/* ---- Links ---- */}
      <div className="links">
        <LinkChip label="Deck" link={b.links.deck} />
        <LinkChip label="CEO LinkedIn" link={b.links.ceoLinkedin} />
        <LinkChip label="CTO LinkedIn" link={b.links.ctoLinkedin} />
        <LinkChip label="Website" link={b.links.website} />
        <LinkChip label="Deal folder" link={b.links.dealFolder} />
        {b.regime === "past" && (
          <LinkChip label="Recording" link={b.links.recording} />
        )}
      </div>

      {/* ---- Expander ---- */}
      <div className="expander">
        <button className="expander-btn" onClick={() => setOpen((o) => !o)}>
          <span className={`chev ${open ? "open" : ""}`}>▸</span>
          {open ? "Hide full bundle" : "Show full bundle"}
        </button>

        {open && (
          <div className="bundle">
            {/* Identity */}
            <div className="section">
              <h3>Identity</h3>
              <div className="row">
                <span className="what">
                  {b.identity.description || b.company}
                  {b.identity.domain ? ` · ${b.identity.domain}` : " · no domain"}
                </span>
              </div>
              {(b.identity.location ||
                b.identity.verticals?.length ||
                b.identity.founded) && (
                <div className="row">
                  <span className="what" style={{ color: "var(--text-dim)" }}>
                    {[
                      b.identity.verticals?.join(", "),
                      b.identity.location,
                      b.identity.founded ? `founded ${b.identity.founded}` : null,
                      b.identity.capitalRaising
                        ? `raising ${b.identity.capitalRaising}`
                        : null,
                      b.identity.capitalRaised
                        ? `raised ${b.identity.capitalRaised}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              )}
              {b.identity.sourcedBy && (
                <div className="row">
                  <span className="what" style={{ color: "var(--text-dim)" }}>
                    Sourced by {b.identity.sourcedBy}
                  </span>
                </div>
              )}
            </div>

            {/* People */}
            <div className="section">
              <h3>People</h3>
              {b.people.map((p, i) => (
                <div className="person" key={i}>
                  <div>
                    <span className="name">{p.name}</span>
                    {p.role ? ` — ${p.role}` : ""}
                    <Tags sources={p.sources} />
                  </div>
                  {p.emails.length > 0 && (
                    <div className="emails">{p.emails.join(" · ")}</div>
                  )}
                  {p.background && <div className="bg">{p.background}</div>}
                </div>
              ))}
              {b.introSource && (
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="when">Intro</span>
                  <span className="what">
                    {b.introSource.value}
                    <Tags sources={b.introSource.sources} />
                  </span>
                </div>
              )}
            </div>

            {/* Timeline */}
            <div className="section">
              <h3>Interaction timeline</h3>
              {b.timeline.length === 0 ? (
                <div className="empty-note">No interactions on file.</div>
              ) : (
                b.timeline.map((t, i) => (
                  <div className="row" key={i}>
                    <span className="when">{t.date}</span>
                    <span className="what">
                      {t.summary}
                      <Tags sources={t.sources} />
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Meetings */}
            {b.meetings.length > 0 &&
              (() => {
                const isUpcoming = (m: (typeof b.meetings)[number]) => !!m.upcoming;
                const ms = (m: (typeof b.meetings)[number]) =>
                  m.startISO ? new Date(m.startISO).getTime() : 0;
                const upcoming = b.meetings.filter(isUpcoming).sort((a, x) => ms(a) - ms(x));
                const past = b.meetings.filter((m) => !isUpcoming(m)).sort((a, x) => ms(x) - ms(a));
                const rsvpLabel = (s?: string) =>
                  !s || s === "accepted"
                    ? ""
                    : ` (${s === "needsAction" ? "no reply" : s})`;
                return (
                  <div className="section">
                    <h3>Meetings</h3>
                    {[...upcoming, ...past].map((m, i) => (
                      <div className="row" key={i}>
                        <span className="when">
                          {isUpcoming(m) && <span className="pill-up">soon</span>}
                          {m.datetime}
                        </span>
                        <span className="what">
                          "{m.title}"
                          {m.recordingUrl && (
                            <>
                              {" · "}
                              <a href={m.recordingUrl} target="_blank" rel="noreferrer">
                                recording ↗
                              </a>
                            </>
                          )}
                          <Tags sources={m.sources} />
                          <div className="attendees">
                            {m.attendees.map((a, j) => (
                              <span key={j} className={a.rsvp === "declined" ? "att declined" : "att"}>
                                {a.name || a.email}
                                {rsvpLabel(a.rsvp)}
                                {j < m.attendees.length - 1 ? ", " : ""}
                              </span>
                            ))}
                          </div>
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()}

            {/* Grain */}
            {b.grainRecordings.length > 0 && (
              <div className="section">
                <h3>Grain recordings</h3>
                {b.grainRecordings.map((g, i) => (
                  <div className="grain-rec" key={i}>
                    <div className="rec-title">
                      <span>{g.title}</span>
                      <a href={g.url} target="_blank" rel="noreferrer">
                        open ↗
                      </a>
                    </div>
                    <div className="rec-meta">
                      {g.date}
                      {g.duration ? ` · ${g.duration}` : ""}
                    </div>
                    {g.summary && <div className="rec-summary">{g.summary}</div>}
                    {g.keyPoints && g.keyPoints.length > 0 && (
                      <ul>
                        {g.keyPoints.map((k, j) => (
                          <li key={j}>
                            {k.speaker && <span className="speaker">{k.speaker}: </span>}
                            {k.point}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Email */}
            {b.emailThread && (
              <div className="section">
                <h3>Email thread</h3>
                {b.emailThread.messages.map((m, i) => (
                  <div className="row" key={i}>
                    <span className="when">{m.date}</span>
                    <span className="what">
                      <b>{m.from}</b> → {m.to}: {m.oneLine}
                    </span>
                  </div>
                ))}
                {b.emailThread.intro && (
                  <div className="row">
                    <span className="when">Intro</span>
                    <span className="what">{b.emailThread.intro}</span>
                  </div>
                )}
                {b.emailThread.outcome && (
                  <div className="row">
                    <span className="when">Outcome</span>
                    <span className="what">{b.emailThread.outcome}</span>
                  </div>
                )}
              </div>
            )}

            {/* Notes */}
            <div className="section">
              <h3>Attio notes</h3>
              {b.attioNotes.length === 0 ? (
                <div className="empty-note">
                  None found — meeting intelligence often lives only in Grain.
                </div>
              ) : (
                b.attioNotes.map((n, i) => (
                  <div className="row" key={i}>
                    <span className="when">{n.date}</span>
                    <span className="what">
                      <b>{n.title}</b> — {n.extract}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Gaps */}
            {b.gaps.length > 0 && (
              <div className="section">
                <h3>Gaps &amp; flags</h3>
                {b.gaps.map((g, i) => (
                  <div className="gap" key={i}>
                    <span className="dot">◆</span>
                    <span>
                      {g.description}
                      {g.resolution ? ` — ${g.resolution}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
