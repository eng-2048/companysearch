"use client";

import { useState } from "react";
import { ContextBundle, GrainRecording, Sourced } from "@/lib/types";

/** Map a pipeline status to a color category. */
function statusClass(status?: string): string {
  if (!status) return "st-neutral";
  const s = status.toLowerCase();
  if (s.includes("pass") || s.includes("lost")) return "st-red";
  if (s.includes("watch")) return "st-orange";
  if (s.includes("termsheet") || s.includes("term sheet") || s.includes("closing") || s.includes("closed"))
    return "st-blue";
  if (s.includes("new") || s.includes("screen") || s.includes("deep dive") || s.includes("diligence"))
    return "st-green";
  return "st-neutral";
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

/** A Grain recording: date · title · duration always visible; content collapsible. */
function GrainRow({ g }: { g: GrainRecording }) {
  const [open, setOpen] = useState(false);
  const hasContent = !!g.summary || (g.keyPoints && g.keyPoints.length > 0);
  return (
    <div className="grain-rec">
      <div className="rec-head">
        <button
          className="rec-toggle"
          onClick={() => setOpen((o) => !o)}
          disabled={!hasContent}
        >
          {hasContent && <span className={`chev ${open ? "open" : ""}`}>▸</span>}
          <span className="rec-date">{g.date}</span>
          <span className="rec-title-text">{g.title}</span>
          {g.duration && <span className="rec-dur">{g.duration}</span>}
        </button>
        <a href={g.url} target="_blank" rel="noreferrer" className="rec-link">
          open ↗
        </a>
      </div>
      {open && hasContent && (
        <div className="rec-body">
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
      )}
    </div>
  );
}

export default function ResultCard({ bundle }: { bundle: ContextBundle }) {
  const [open, setOpen] = useState(false);
  const b = bundle;

  const tagline = [b.identity.verticals?.join(", "), b.identity.location]
    .filter(Boolean)
    .join(" · ");

  // Visual timeline: intro, then meetings oldest → newest.
  const introDate = b.emailThread?.messages[0]?.date;
  const hasIntro = !!(b.introSource || b.emailThread?.intro);
  const ms = (iso?: string) => (iso ? new Date(iso).getTime() : 0);
  const meetingsChrono = [...b.meetings].sort((a, x) => ms(a.startISO) - ms(x.startISO));
  const grainsChrono = [...b.grainRecordings].sort((a, x) => a.date.localeCompare(x.date)).reverse();

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
            {tagline && <div className="tagline">{tagline}</div>}
          </div>
          {b.identity.pipelineStatus?.value && (
            <span className={`pill ${statusClass(b.identity.pipelineStatus.value)}`}>
              {b.identity.pipelineStatus.value}
            </span>
          )}
        </div>
      </div>

      {/* ---- Description ---- */}
      {b.identity.description && <div className="card-summary">{b.identity.description}</div>}

      {/* ---- Links ---- */}
      <div className="links">
        <LinkChip label="Deck" link={b.links.deck} />
        <LinkChip label="CEO LinkedIn" link={b.links.ceoLinkedin} />
        <LinkChip label="CTO LinkedIn" link={b.links.ctoLinkedin} />
        <LinkChip label="Website" link={b.links.website} />
        <LinkChip label="Deal folder" link={b.links.dealFolder} />
        {b.regime === "past" && <LinkChip label="Recording" link={b.links.recording} />}
        <LinkChip label="Attio Record" link={b.links.attioRecord} />
      </div>

      {/* ---- Expander ---- */}
      <div className="expander">
        <button className="expander-btn" onClick={() => setOpen((o) => !o)}>
          <span className={`chev ${open ? "open" : ""}`}>▸</span>
          {open ? "Hide full bundle" : "Show full bundle"}
        </button>

        {open && (
          <div className="bundle">
            {/* People */}
            {b.people.length > 0 && (
              <div className="section">
                <h3>People</h3>
                {b.people.map((p, i) => (
                  <div className="person" key={i}>
                    <div>
                      <span className="name">{p.name}</span>
                      {p.role ? ` — ${p.role}` : ""}
                    </div>
                    {p.emails.length > 0 && <div className="emails">{p.emails.join(" · ")}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Interaction timeline — visual */}
            <div className="section">
              <h3>Interaction timeline</h3>
              <div className="timeline-v">
                {hasIntro && (
                  <div className="tl-node tl-intro">
                    {introDate && <div className="tl-when">{introDate}</div>}
                    <div className="tl-title">Introduced</div>
                    <div className="tl-detail">
                      {b.introSource ? `via ${b.introSource.value}` : b.emailThread?.intro}
                    </div>
                  </div>
                )}
                {meetingsChrono.map((m, i) => (
                  <div className={`tl-node ${m.upcoming ? "tl-upcoming" : ""}`} key={i}>
                    <div className="tl-when">
                      {m.datetime}
                      {m.upcoming && <span className="pill-up">soon</span>}
                    </div>
                    <div className="tl-title">
                      {m.title}
                      {m.recordingUrl && (
                        <>
                          {" · "}
                          <a href={m.recordingUrl} target="_blank" rel="noreferrer">
                            recording ↗
                          </a>
                        </>
                      )}
                      {m.notesUrl && (
                        <>
                          {" · "}
                          <a href={m.notesUrl} target="_blank" rel="noreferrer">
                            Attio notes ↗
                          </a>
                        </>
                      )}
                    </div>
                    {m.attendees.length > 0 && (
                      <div className="tl-detail">
                        {m.attendees.map((a, j) => (
                          <span key={j} className={a.rsvp === "declined" ? "att declined" : "att"}>
                            {a.name || a.email}
                            {a.rsvp && a.rsvp !== "accepted"
                              ? ` (${a.rsvp === "needsAction" ? "no reply" : a.rsvp})`
                              : ""}
                            {j < m.attendees.length - 1 ? ", " : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {!hasIntro && meetingsChrono.length === 0 && (
                  <div className="empty-note">No interactions on file.</div>
                )}
              </div>
            </div>

            {/* Grain recordings */}
            {grainsChrono.length > 0 && (
              <div className="section">
                <h3>Grain recordings</h3>
                {grainsChrono.map((g) => (
                  <GrainRow g={g} key={g.id} />
                ))}
              </div>
            )}

            {/* Email thread */}
            {b.emailThread && (
              <div className="section">
                <h3>Email thread</h3>
                {b.emailThread.outcome && (
                  <div className="email-flag">
                    <span className="ef-label">Latest</span> {b.emailThread.outcome}
                  </div>
                )}
                {b.emailThread.messages.map((m, i) => (
                  <div className="row" key={i}>
                    <span className="when">{m.date}</span>
                    <span className="what">
                      <b>{m.from}</b>: {m.oneLine}
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
