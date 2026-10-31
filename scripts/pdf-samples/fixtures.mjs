// Invented sample data for scripts/pdf-samples/render.mjs. Nothing here is a real applicant,
// employer figure or search result; the shapes match what the tracker builds and stores.

export const application = {
  name: "María José Fernández Ortiz",
  subtitle: "Applied March 14, 2026 through the Employment Application-ESP 2025 form · Eugene/Springfield",
  byline: "Rexius Recruiter · prepared by Andy Meyer on Oct 30, 2026, 5:40 PM",
  sections: [
    { title: "Contact", rows: [
      ["Email", "mj.fernandez.ortiz@example.com"], ["Phone", "(541) 555-0142"], ["Alternate phone", ""], ["Phone type", "Cell"], ["Prefers", "Text"],
      ["City", "Springfield, OR"]
    ] },
    { title: "Application", rows: [
      ["Position", "Landscape Crew Member / Miembro de equipo de paisajismo"],
      ["Matched opening", "Landscape Crew Member"],
      ["Location", "Eugene/Springfield"], ["Form", "Employment Application-ESP 2025"],
      ["Heard from", "Indeed.com"], ["Referred by", "Luis Fernández (current employee, Eugene yard)"],
      ["Can start", "March 23, 2026"], ["Education", "High school diploma"], ["Worked at Rexius before", "No"], ["Applied before", "Yes"],
      ["Driver licence class", "Class C"],
      ["Skills", "Tres años de mantenimiento de jardines: cortadoras, sopladores, desbrozadoras, instalación de riego por goteo y reparación de aspersores. Manejo de remolque pequeño. Primeros auxilios básicos. Bilingüe español e inglés (conversacional)."]
    ] },
    { title: "Employment history", jobs: [
      { title: "Landscape maintenance technician", employer: "Willamette Valley Grounds", location: "Eugene, OR", start: "Apr 2023", end: "", reason: "", responsibilities: "Weekly maintenance route of 18 commercial properties: mowing, edging, pruning, seasonal colour changes, irrigation checks and repairs. Trained two new crew members in 2025." },
      { title: "Crew member", employer: "Cascadia Lawn & Garden", location: "Springfield, OR", start: "May 2021", end: "Mar 2023", reason: "Seasonal layoff; company closed its Springfield branch.", responsibilities: "Residential mowing and cleanup, leaf removal, bark delivery and spreading." },
      { title: "Warehouse associate", employer: "NW Nursery Supply", location: "Junction City, OR", start: "Jun 2019", end: "Apr 2021", reason: "Wanted outdoor work.", responsibilities: "Order picking, forklift (certified on site), loading customer trucks, inventory counts." }
    ] },
    { title: "Files", text: "Sent separately from the tracker: Fernandez-Ortiz-resume.pdf." },
    { title: "Other answers", items: [
      { q: "Are you legally authorized to work in the United States? / ¿Está autorizado legalmente para trabajar en los Estados Unidos?", a: "Yes" },
      { q: "Are you at least 18 years of age?", a: "Yes" },
      { q: "Have you ever been convicted of a crime? If yes, please explain. A conviction will not necessarily disqualify you from employment.", a: "No" },
      { q: "What days and hours are you available to work?", a: "Monday to Saturday, 6:00 AM to 5:00 PM. Not available Sundays. Can work overtime in spring." },
      { q: "Do you have reliable transportation to and from work?", a: "Yes, own car." },
      { q: "Why do you want to work at Rexius?", a: "Mi hermano trabaja en el yard de Eugene y habla muy bien de la empresa. Busco un trabajo estable con posibilidad de crecer y aprender sobre instalación de paisajismo, no solo mantenimiento. Me gusta trabajar al aire libre y en equipo." },
      { q: "Anything else you would like us to know?", a: "I am studying for my CDL Class B permit and expect to test in May 2026." },
      { q: "Emergency contact name and phone", a: "Luis Fernández, (541) 555-0177" },
      { q: "Languages spoken", a: "Español (nativo), English (conversational)" },
      { q: "Can you lift 50 lb repeatedly through a shift?", a: "Yes" },
      { q: "Are you comfortable working in rain and heat?", a: "Yes" },
      { q: "Have you operated a blower truck or bark blower?", a: "No, but I have spread bark by hand and from a dump trailer." },
      { q: "References", a: "Carla Núñez, supervisor at Willamette Valley Grounds, (541) 555-0190; Tom Beck, owner, Cascadia Lawn & Garden, (541) 555-0133." }
    ] }
  ],
  note: "This copy was generated from Rexius Recruiter. Driver licence details, signatures and initials are not stored in the tracker and do not appear here; HR can see the original submission in Jotform."
};

export const position = { title: "Blower Truck Operator", location: "Lake Oswego", pay_min: 28, pay_max: 38, pay_unit: "hour" };

const src = (title, url) => ({ title, url, age: null });

export const marketCheck = {
  ran_at: "2026-10-30T17:23:00-07:00", trigger: "manual", model: "claude-opus-5-5", searches: 10, input_tokens: 48210, output_tokens: 3120,
  summary: "Found nine blower truck operator and bark blower driver postings in the Portland metro and the northern Willamette Valley, six of them with pay shown. Hourly figures ran from $24 to $40 an hour, with most clustered between $27 and $34. Two postings asked for a CDL Class B with air brakes; the others accepted a standard licence with a clean record and offered to train on the truck.\n\nThe Rexius range of $28–$38 sits inside what others advertise; the top of the range is above the median low end of $27.50. Three employers advertised a signing or seasonal retention bonus, which no Rexius posting mentions.\n\nThis is a sample from search results, not a complete count.",
  comparison: { unit: "hour", position_min: 28, position_max: 38, market_low_median: 27.5, market_high_median: 33, ranges_compared: 6 },
  below_market: false,
  pay_ranges: [
    { employer: "Pacific Bark & Soil", title: "Bark Blower Truck Driver (CDL B)", min: 30, max: 36, unit: "hour", url: "https://www.indeed.com/viewjob?jk=1" },
    { employer: "Tualatin Valley Landscape Supply", title: "Blower Truck Operator", min: 26, max: 32, unit: "hour", url: "https://www.indeed.com/viewjob?jk=2" },
    { employer: "Northwest Mulch Co.", title: "Mulch Blower Operator / Delivery Driver", min: 24, max: 29, unit: "hour", url: "https://www.ziprecruiter.com/c/nwmulch/job/3" },
    { employer: "Evergreen Grounds Management", title: "Bark Dust Blower Truck Driver", min: 29, max: 34, unit: "hour", url: "https://evergreengm.example.com/careers/4" },
    { employer: "Columbia Soil Products", title: "Blower Truck Operator - Seasonal", min: 27, max: 31, unit: "hour", url: "https://www.indeed.com/viewjob?jk=5" },
    { employer: "Not named in search result", title: "Bark Blower Driver (Portland, OR)", min: 32, max: 40, unit: "hour", url: "https://www.ziprecruiter.com/Jobs/Bark-Blower/-in-Portland,OR" }
  ],
  postings: [
    { employer: "Pacific Bark & Soil", title: "Bark Blower Truck Driver (CDL B)", pay_text: "$30–$36/hr + $1,000 signing bonus", location: "Tualatin, OR", posted: "2026-10-21", url: "https://www.indeed.com/viewjob?jk=1" },
    { employer: "Tualatin Valley Landscape Supply", title: "Blower Truck Operator", pay_text: "$26–$32/hr", location: "Sherwood, OR", posted: "2026-10-18", url: "https://www.indeed.com/viewjob?jk=2" },
    { employer: "Northwest Mulch Co.", title: "Mulch Blower Operator / Delivery Driver", pay_text: "$24–$29/hr", location: "Hillsboro, OR", posted: "2026-10-27", url: "https://www.ziprecruiter.com/c/nwmulch/job/3" },
    { employer: "Evergreen Grounds Management", title: "Bark Dust Blower Truck Driver", pay_text: "$29–$34/hr DOE", location: "Clackamas, OR", posted: "2026-10-02", url: "https://evergreengm.example.com/careers/4" },
    { employer: "Columbia Soil Products", title: "Blower Truck Operator - Seasonal", pay_text: "$27–$31/hr", location: "Wilsonville, OR", posted: null, url: "https://www.indeed.com/viewjob?jk=5" },
    { employer: "Portland Parks & Recreation", title: "Utility Worker II - Grounds (Blower Truck)", pay_text: null, location: "Portland, OR", posted: "2026-10-09", url: "https://www.governmentjobs.com/careers/portlandor/jobs/6" },
    { employer: "Rose City Landscaping", title: "Blower Truck Driver", pay_text: null, location: "Gresham, OR", posted: "2026-10-25", url: "https://www.indeed.com/viewjob?jk=7" },
    { employer: "Not named in search result", title: "Bark Blower Driver", pay_text: "$32–$40/hr", location: "Portland, OR", posted: null, url: "https://www.ziprecruiter.com/Jobs/Bark-Blower/-in-Portland,OR" },
    { employer: "Salem Bark & Gravel", title: "Blower Truck Operator & Yard Hand", pay_text: null, location: "Salem, OR", posted: "2026-10-12", url: "https://www.craigslist.org/pdx/lab/8" }
  ],
  sources: [
    src("Blower Truck Operator Jobs, Employment in Portland, OR | Indeed", "https://www.indeed.com/q-blower-truck-operator-l-portland,-or-jobs.html"),
    src("$24-$40/hr Bark Blower Jobs in Portland, OR (NOW HIRING) Oct 2026", "https://www.ziprecruiter.com/Jobs/Bark-Blower/-in-Portland,OR"),
    src("Bark Blower Truck Driver (CDL B) - Pacific Bark & Soil - Tualatin, OR - Indeed.com", "https://www.indeed.com/viewjob?jk=1"),
    src("Blower Truck Operator - Tualatin Valley Landscape Supply", "https://www.indeed.com/viewjob?jk=2"),
    src("Mulch Blower Operator / Delivery Driver Job in Hillsboro, OR at Northwest Mulch Co.", "https://www.ziprecruiter.com/c/nwmulch/job/3"),
    src("Careers<!-- --> - Evergreen Grounds Management", "https://evergreengm.example.com/careers/4"),
    src("Blower Truck Operator - Seasonal - Columbia Soil Products", "https://www.indeed.com/viewjob?jk=5"),
    src("Utility Worker II - Grounds | Job Details tab | Career Pages", "https://www.governmentjobs.com/careers/portlandor/jobs/6"),
    src("Blower Truck Driver - Rose City Landscaping - Gresham, OR", "https://www.indeed.com/viewjob?jk=7"),
    src("Blower Truck Operator & Yard Hand - general labor - job employment", "https://www.craigslist.org/pdx/lab/8"),
    src("Blower Truck Operator Salary in Oregon: Hourly Rate (Oct, 2026)", "https://www.ziprecruiter.com/Salaries/Blower-Truck-Operator-Salary--in-Oregon"),
    src("", "https://www.glassdoor.com/Job/portland-bark-blower-jobs-SRCH_IL.0,8_IC1151614_KO9,20.htm?utm_source=search&utm_medium=cpc&utm_campaign=long-tracking-string-that-wraps"),
    src("Heavy and Tractor-Trailer Truck Drivers : Occupational Outlook Handbook", "https://www.bls.gov/ooh/transportation-and-material-moving/heavy-and-tractor-trailer-truck-drivers.htm")
  ]
};

export const nationalCheck = {
  ran_at: "2026-10-30T17:23:00-07:00", pass: 2, model: "claude-opus-5-5", searches: 13, input_tokens: 91200, output_tokens: 6400,
  summary: "Found 7 blower truck operator/driver postings with pay, in the Midwest (Detroit, MI; Madison, WI), the Southeast (Tampa, FL; Charlotte, NC), Texas (Sherman, TX), New England (Manchester, NH) and the West (Medford, OR); three of them did not name the employer in the search results. Hourly postings ranged from $19 to $30 an hour, and salaried postings from $65,000 to $85,000 a year; most search results showed no posting date, so recency within 90 days is not confirmed. For Heavy and Tractor-Trailer Truck Drivers (SOC 53-3032), 2025 BLS wage data, as shown on O*NET, has a national median of $28.19 an hour, a 25th percentile of $23.06 and a 75th percentile of $33.23.\n\nScaled to the Portland-Vancouver-Hillsboro, OR-WA cost of living (index 106.6 against 100 for the US average), the 7 comparable postings advertise a median of $25.59 to $31.16 an hour. The BLS national median scaled the same way is $30.05 an hour. Rexius' advertised top of $38 an hour is at or above that adjusted median low end.",
  comparison: { unit: "hour", position_min: 28, position_max: 38, adjusted_low_median: 25.59, adjusted_high_median: 31.16, raw_low_median: 24, raw_high_median: 29, samples_compared: 7, bls_national_median_adjusted: 30.05 },
  below_market: false,
  bls: { occupation: "Heavy and Tractor-Trailer Truck Drivers", soc_code: "53-3032", unit: "hour", national_median: 28.19, p25: 23.06, p75: 33.23, area_name: null, area_median: null, year: 2025, source_url: "https://www.onetonline.org/link/localwages/53-3032.00" },
  cost_of_living: { source_name: "BEA Regional Price Parities by Metropolitan Area, All Items (Table 4, news release of December 12, 2024)", source_url: "https://www.bea.gov/", year: 2023, rexius_metro: "Portland-Vancouver-Hillsboro, OR-WA", rexius_index: 106.6,
    metros: [{ metro: "Detroit-Warren-Dearborn, MI", index: 98 }, { metro: "Tampa-St. Petersburg-Clearwater, FL", index: 103.4 }],
    notes: "Posting names were matched to BEA metropolitan statistical area names (Detroit = Detroit-Warren-Dearborn, MI; Tampa = Tampa-St. Petersburg-Clearwater, FL; Charlotte = Charlotte-Concord-Gastonia, NC-SC; Sherman = Sherman-Denison, TX; Manchester = Manchester-Nashua, NH). RPPs measure differences in price levels across areas for a single year and are not inflation rates. This was the most recent BEA release found in the search; a later release with 2024 data was not checked." },
  pay_samples: [
    { employer: "Superior Groundcover Inc.", title: "Blower Truck Operator", metro: "Detroit, MI", state: "MI", min: 19, max: 29, unit: "hour", url: "https://www.ziprecruiter.com/c/superior/job/1" },
    { employer: "First Coast Mulch", title: "Mulch Blower Truck Driver", metro: "Tampa, FL", state: "FL", min: 33.65, max: 40.87, unit: "hour", url: "https://www.indeed.com/viewjob?jk=fcm" },
    { employer: "Mulch Solutions LLC", title: "Blower Truck Operator", metro: "Charlotte, NC", state: "NC", min: 31.25, max: 36.06, unit: "hour", url: "https://www.indeed.com/viewjob?jk=msl" },
    { employer: "Soil Express Ltd", title: "Blower Truck Driver", metro: "Sherman, TX", state: "TX", min: 26, max: 26, unit: "hour", url: "https://www.simplyhired.com/job/se" },
    { employer: "Not named in search result", title: "Blower Truck Operator", metro: "Madison, WI", state: "WI", min: 23, max: 28, unit: "hour", url: "https://www.ziprecruiter.com/Jobs/Blower-Truck-Operator/-in-Madison,WI" },
    { employer: "Not named in search result", title: "Bark Blower Driver", metro: "Medford, OR", state: "OR", min: 24, max: 30, unit: "hour", url: "https://www.ziprecruiter.com/Jobs/Blower/-in-Medford,OR" },
    { employer: "Not named in search result", title: "Mulch Blower Operator", metro: "Manchester, NH", state: "NH", min: 20, max: 28, unit: "hour", url: "https://www.ziprecruiter.com/Jobs/Blower-Truck/-in-Manchester,NH" }
  ],
  adjusted: [
    { employer: "Superior Groundcover Inc.", title: "Blower Truck Operator", metro: "Detroit, MI", min: 19, max: 29, unit: "hour", index: 98, adjusted_min: 20.67, adjusted_max: 31.54 },
    { employer: "First Coast Mulch", title: "Mulch Blower Truck Driver", metro: "Tampa, FL", min: 33.65, max: 40.87, unit: "hour", index: 103.4, adjusted_min: 34.7, adjusted_max: 42.13 },
    { employer: "Mulch Solutions LLC", title: "Blower Truck Operator", metro: "Charlotte, NC", min: 31.25, max: 36.06, unit: "hour", index: 97, adjusted_min: 34.34, adjusted_max: 39.63 },
    { employer: "Soil Express Ltd", title: "Blower Truck Driver", metro: "Sherman, TX", min: 26, max: 26, unit: "hour", index: 91.8, adjusted_min: 30.1, adjusted_max: 30.1 },
    { employer: "Not named in search result", title: "Blower Truck Operator", metro: "Madison, WI", min: 23, max: 28, unit: "hour", index: 95.8, adjusted_min: 25.59, adjusted_max: 31.16 },
    { employer: "Not named in search result", title: "Bark Blower Driver", metro: "Medford, OR", min: 24, max: 30, unit: "hour", index: 103.3, adjusted_min: 24.77, adjusted_max: 30.96 },
    { employer: "Not named in search result", title: "Mulch Blower Operator", metro: "Manchester, NH", min: 20, max: 28, unit: "hour", index: 105.1, adjusted_min: 20.29, adjusted_max: 28.4 }
  ],
  sources: [
    src("Blower Truck Operator Jobs, Employment | Indeed", "https://www.indeed.com/q-blower-truck-operator-jobs.html"),
    src("$15-$22/hr Blower Job Jobs (NOW HIRING) May 2026", "https://www.ziprecruiter.com/Jobs/Blower-Job"),
    src("$19-$27/hr Blower Truck Operator Jobs (NOW HIRING) Oct 2026", "https://www.ziprecruiter.com/Jobs/Blower-Truck-Operator"),
    src("Mulch Blower Truck Operator Jobs, Employment | Indeed", "https://www.indeed.com/q-mulch-blower-truck-operator-jobs.html"),
    src("$18-$40/hr Blower Truck Driver Jobs (NOW HIRING) Jul 26", "https://www.ziprecruiter.com/Jobs/Blower-Truck-Driver"),
    src("Mulch Blower Truck Operator $40,000 Jobs, Employment", "https://www.indeed.com/q-mulch-blower-truck-operator-$40,000-jobs.html"),
    src("Ground Solutions hiring Blower Truck Operator- Commercial Driver in Charlotte, NC", "https://www.glassdoor.com/job-listing/blower-truck-operator-commercial-driver-ground-solutions-JV_KO0,47_KE48,64.htm?jl=1010145972533"),
    src("BARK KING BLOWER TRUCK SERVICE Landscape Laborer Job in Everett, WA", "https://www.ziprecruiter.com/c/BARK-KING-BLOWER-TRUCK-SERVICE/Job/Landscape-Laborer/-in-Everett,WA?jid=3aa2b2b74cd40fb2"),
    src("Bark King Blower Truck Service Careers and Employment", "https://www.indeed.com/cmp/Bark-King-Blower-Truck-Service-1"),
    src("20 Best blower truck operator jobs (Hiring Now!) | SimplyHired", "https://www.simplyhired.com/search?q=mulch+blower+operator"),
    src("CDL-B Driver - Blower Truck Operator Job - Concord, NC - Mulch Solutions LLC", "https://jobs.wizehire.com/job/cdl-b-driver-blower-truck-operator-in-concord-nc-451750ac86d415f4"),
    src("Pneumatic Blower Truck Operator Jobs, Employment", "https://indeed.com/q-pneumatic-blower-truck-operator-jobs.html"),
    src("Heavy and Tractor-trailer Truck Drivers<!-- -->", "https://seasonaljobs.dol.gov/jobs/H-300-26239-197806"),
    src("Heavy and Tractor-Trailer Truck Drivers", "https://blsmon1.bls.gov/oes/2023/may/oes533032.htm"),
    src("National Wages: 53-3032.00 - Heavy and Tractor-Trailer Truck Drivers", "https://www.onetonline.org/link/localwages/53-3032.00?st="),
    src("Heavy and Tractor-Trailer Truck Drivers : Occupational Outlook Handbook", "https://www.bls.gov/ooh/transportation-and-material-moving/heavy-and-tractor-trailer-truck-drivers.htm"),
    src("Truck Driver Salary by State 2024", "https://truckradar.ai/market/driver-wages"),
    src("Regional Price Parities by State and Metro Area | U.S. Bureau of Economic Analysis (BEA)", "https://www.bea.gov/data/prices-inflation/regional-price-parities-state-and-metro-area")
  ]
};
