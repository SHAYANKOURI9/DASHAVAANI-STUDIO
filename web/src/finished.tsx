import { useEffect, useState } from "react"
import { t } from "./i18n.js"
import DiscCascadeCarousel, { type DiscCascadeItem, type DiscPattern } from "@/components/ui/disc-cascade-carousel"

type Job = { id: string; status: string; lang: string; headline?: string; category?: string; template?: string; createdAt: string }

// One disc look per video template, in the site palette (black, red, white).
const LOOK: Record<string, { name: string; pattern: DiscPattern; palette: [string, string, string] }> = {
  lead: { name: t("Lead Desk"), pattern: "rings", palette: ["#141416", "#2a2a2e", "#d8341f"] },
  breaking: { name: t("Breaking"), pattern: "stripes", palette: ["#d8341f", "#b52a17", "#f4f4f5"] },
  numbers: { name: t("Numbers Desk"), pattern: "halftone", palette: ["#f4f4f5", "#141416", "#d8341f"] },
}
const LANG: Record<string, string> = { en: t("English"), te: t("Telugu") }
const ANEK = '"Anek Latin", "Noto Sans Telugu", "Noto Sans Devanagari", system-ui, sans-serif'

// Finished stories as discs. The rundown in app.js broadcasts the job list; choosing a disc opens that story.
export default function Finished() {
  const [jobs, setJobs] = useState<Job[]>([])
  useEffect(() => {
    const take = (list: Job[]) => setJobs(list.filter((j) => j.status === "done" && j.headline))
    const on = (e: Event) => take((e as CustomEvent<Job[]>).detail)
    take((window as unknown as { dvJobs?: Job[] }).dvJobs ?? [])
    addEventListener("dv:jobs", on)
    return () => removeEventListener("dv:jobs", on)
  }, [])

  useEffect(() => {
    const section = document.getElementById("work")
    if (section) section.hidden = jobs.length === 0
  }, [jobs.length])
  if (!jobs.length) return null

  const items: DiscCascadeItem[] = jobs.map((j) => {
    const look = LOOK[j.template ?? "lead"] ?? LOOK.lead
    return {
      title: j.headline!,
      label: j.category || look.name,
      pattern: look.pattern,
      palette: look.palette,
      credits: [
        { label: t("Language"), value: LANG[j.lang] ?? j.lang },
        { label: t("Template"), value: look.name },
        { label: t("Filed"), value: new Date(j.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) },
      ],
      fine: t("Dashavani · verified by the editorial desk"),
    }
  })

  return (
    <DiscCascadeCarousel
      items={items}
      height="min(680px, 88svh)"
      defaultIndex={0}
      brand="Dashavani"
      indexLabel={jobs.length > 1 ? t("All finished videos") : ""}
      reviews={false}
      frame={false}
      hint={jobs.length > 1 ? t("Drag or use the arrow keys") : ""}
      background="radial-gradient(60% 70% at 50% 45%, rgba(216, 52, 31, .18), transparent 70%), #0a0a0b"
      color="#f4f4f5"
      serif={ANEK}
      sans={ANEK}
      display={ANEK}
      onSelect={(_, i) => dispatchEvent(new CustomEvent("dv:open", { detail: jobs[i].id }))}
      ariaLabel={t("Finished videos")}
    />
  )
}
