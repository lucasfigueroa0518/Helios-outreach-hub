# Cost report — Campaign #5
Campaign ID: 2b27a197-3b22-4fba-baa4-d8f190ef99f7
Leads on campaign: 55
Successful drafts (ready_for_review / approved): 38
Generated: 2026-07-28T14:59:31.383Z

## A) All-inclusive ledger (retries + failures included)

Ground-truth spend is taken from job rows (company_research_jobs + drafting_jobs).
Per-lead ledger events allocate enrichment shares and may retain historical drafting rounds.

### Enrichment
| Job kind / status | Jobs | Cost |
|---|---:|---:|
| primary/done | 4 | $0.2060 |
| profile_rescue/done | 3 | $0.0870 |
| **Job total** | **7** | **$0.2930** |
| Lead-share ledger events | 385 | $0.2915 |

### Drafting
| Kind / status | Jobs | Cost |
|---|---:|---:|
| research/done | 38 | $6.4422 |
| research/failed | 12 | $0.0000 |
| research/in_flight | 1 | $0.0000 |
| write/superseded | 38 | $0.6018 |
| **Job total** | **89** | **$7.0440** |
| Aggregated lead_cost_events (may include prior resets) | 74 | $13.5810 |

### All-inclusive totals (job ground truth)
| Phase | Cost |
|---|---:|
| Enrichment | $0.2930 |
| Drafting | $7.0440 |
| **Combined** | **$7.3370** |

Per-lead average (all-inclusive, over 55 campaign leads): $0.1334
Per successful-draft lead average (all-inclusive drafting attributed / 38): $0.1854

### All-inclusive per-lead (top 15 by total)
| Lead | Enrichment (ledger shares) | Drafting (all jobs) | Research jobs | Failed research | Write jobs | Total |
|---|---:|---:|---:|---:|---:|---:|
| Nada Yared | $0.0053 | $0.2933 | 1 | 0 | 1 | $0.2986 |
| Steve Cirulis | $0.0053 | $0.2473 | 1 | 0 | 1 | $0.2526 |
| Rulfo Hernandez | $0.0053 | $0.2397 | 1 | 0 | 1 | $0.2450 |
| Ashlee Weisser | $0.0053 | $0.2387 | 2 | 1 | 1 | $0.2440 |
| Trona Balkissoon | $0.0053 | $0.2373 | 1 | 0 | 1 | $0.2426 |
| Franco Da Costa Gomez | $0.0053 | $0.2346 | 1 | 0 | 1 | $0.2399 |
| Craig Fullalove | $0.0053 | $0.2296 | 1 | 0 | 1 | $0.2349 |
| Andrew Insch | $0.0053 | $0.2257 | 1 | 0 | 1 | $0.2310 |
| Michael Dixon | $0.0053 | $0.2230 | 1 | 0 | 1 | $0.2283 |
| Michelle Huang | $0.0053 | $0.2212 | 1 | 0 | 1 | $0.2265 |
| Xavier Blanco | $0.0053 | $0.2193 | 1 | 0 | 1 | $0.2246 |
| Richard Koeken | $0.0053 | $0.2171 | 1 | 0 | 1 | $0.2224 |
| Adam Friedman | $0.0053 | $0.2112 | 1 | 0 | 1 | $0.2165 |
| Matthieu Dewavrin | $0.0053 | $0.2079 | 1 | 0 | 1 | $0.2132 |
| Yuliya Varabei | $0.0053 | $0.2067 | 2 | 1 | 1 | $0.2120 |

## B) Successful-run only (one good path per successful lead)

Rules:
- Enrichment: lead-share costs from **done** company research jobs, only for leads with a successful draft
- Drafting: for each `ready_for_review`/`approved` item, keep the **last done research** job and the **last charged write** job; drop failed research and earlier attempts
- Enrichment job-level done total shown for reference (not double-counted with lead shares)

### Successful totals
| Phase | Cost | Notes |
|---|---:|---|
| Enrichment (lead shares on successful leads) | $0.2014 | From done jobs only |
| Enrichment (done jobs, company-level) | $0.2930 | Same 7 jobs — shared across leads |
| Drafting research (last done / lead) | $6.4422 | 38 leads |
| Drafting write (last charged / lead) | $0.6018 | 38 leads |
| **Drafting successful path** | **$7.0440** | |
| **Combined (enrich lead-shares + successful drafting)** | **$7.2454** | |

Per successful draft: $0.1854 drafting
Per successful draft + its enrichment share: $0.1907

### Waste / retry overhead (drafting jobs)
| | Cost |
|---|---:|
| All drafting jobs | $7.0440 |
| Successful path only | $7.0440 |
| **Retries / failed / superseded extras** | **$0.0000** |

### Successful per-lead (all 38)
| Lead | Enrichment share | Research | Write | Drafting total | Excluded research jobs | Excluded write jobs |
|---|---:|---:|---:|---:|---:|---:|
| Adam Friedman | $0.0053 | $0.1955 | $0.0157 | $0.2112 | 0 | 0 |
| Alena Dmyterko | $0.0053 | $0.0043 | $0.0179 | $0.0222 | 0 | 0 |
| Alison Burhite | $0.0053 | $0.1879 | $0.0155 | $0.2034 | 1 | 0 |
| Andrea Carter | $0.0053 | $0.1588 | $0.0161 | $0.1749 | 0 | 0 |
| Andres Rovirosa | $0.0053 | $0.1756 | $0.0164 | $0.1920 | 0 | 0 |
| Andrew Insch | $0.0053 | $0.2108 | $0.0149 | $0.2257 | 0 | 0 |
| Ashlee Weisser | $0.0053 | $0.2216 | $0.0171 | $0.2387 | 1 | 0 |
| Comer Wilson | $0.0053 | $0.0174 | $0.0144 | $0.0318 | 0 | 0 |
| Craig Fullalove | $0.0053 | $0.2154 | $0.0142 | $0.2296 | 0 | 0 |
| Dan Maxwell | $0.0053 | $0.1548 | $0.0162 | $0.1710 | 0 | 0 |
| David Schoenberger | $0.0053 | $0.1746 | $0.0162 | $0.1908 | 1 | 0 |
| Derek Andersen | $0.0053 | $0.1832 | $0.0145 | $0.1977 | 1 | 0 |
| Emily Baumhauer | $0.0053 | $0.1834 | $0.0168 | $0.2002 | 0 | 0 |
| Franco Da Costa Gomez | $0.0053 | $0.2190 | $0.0156 | $0.2346 | 0 | 0 |
| Gary Smith | $0.0053 | $0.1785 | $0.0146 | $0.1931 | 1 | 0 |
| Heather Enderby | $0.0053 | $0.1869 | $0.0151 | $0.2020 | 1 | 0 |
| Jack Portlock | $0.0053 | $0.1791 | $0.0156 | $0.1947 | 1 | 0 |
| James Ipock | $0.0053 | $0.0052 | $0.0157 | $0.0209 | 0 | 0 |
| Jennifer Hemingway | $0.0053 | $0.1873 | $0.0143 | $0.2016 | 0 | 0 |
| Joel Martin | $0.0053 | $0.1658 | $0.0161 | $0.1819 | 0 | 0 |
| John H. | $0.0053 | $0.1811 | $0.0153 | $0.1964 | 0 | 0 |
| Lauren Rotmil | $0.0053 | $0.0167 | $0.0170 | $0.0337 | 0 | 0 |
| Matthieu Dewavrin | $0.0053 | $0.1907 | $0.0172 | $0.2079 | 0 | 0 |
| Michael Dixon | $0.0053 | $0.2061 | $0.0169 | $0.2230 | 0 | 0 |
| Michele Riley | $0.0053 | $0.1839 | $0.0154 | $0.1993 | 0 | 0 |
| Michelle Huang | $0.0053 | $0.2046 | $0.0166 | $0.2212 | 0 | 0 |
| Mike Sommers | $0.0053 | $0.1752 | $0.0166 | $0.1918 | 1 | 0 |
| Nada Yared | $0.0053 | $0.2779 | $0.0154 | $0.2933 | 0 | 0 |
| Oscar Cabrera | $0.0053 | $0.1708 | $0.0154 | $0.1862 | 0 | 0 |
| Richard Crai | $0.0053 | $0.1839 | $0.0151 | $0.1990 | 0 | 0 |
| Richard Koeken | $0.0053 | $0.2017 | $0.0154 | $0.2171 | 0 | 0 |
| Rulfo Hernandez | $0.0053 | $0.2244 | $0.0153 | $0.2397 | 0 | 0 |
| Scott Wiebel | $0.0053 | $0.0053 | $0.0156 | $0.0209 | 0 | 0 |
| Steve Cirulis | $0.0053 | $0.2287 | $0.0186 | $0.2473 | 0 | 0 |
| Tien Nguyen | $0.0053 | $0.1712 | $0.0147 | $0.1859 | 0 | 0 |
| Trona Balkissoon | $0.0053 | $0.2214 | $0.0159 | $0.2373 | 0 | 0 |
| Xavier Blanco | $0.0053 | $0.2025 | $0.0168 | $0.2193 | 0 | 0 |
| Yuliya Varabei | $0.0053 | $0.1910 | $0.0157 | $0.2067 | 1 | 0 |

## Headlines
- **All-in spend (jobs):** $7.3370 (enrich $0.2930 + draft $7.0440)
- **Successful-path spend:** $7.2454 (enrich shares $0.2014 + draft $7.0440)
- **Drafting retry waste:** $0.0000 (0.0% of drafting job spend)
- **Note:** write jobs finished as `superseded` in this pipeline but still carry `actual_cost_usd` — counted in both reports when charged.