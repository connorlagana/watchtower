/**
 * The built-in board directory: public job boards of tech companies and
 * startups that Watchtower monitors on its own, so a search watch (filters,
 * no URL) has postings to match.
 *
 * 1061 boards. Every one answered its platform's public listing API with
 * open jobs when the list was last verified (2026-10-01). Most were found with
 * scripts/discover-boards.ts from the public Y Combinator company directory;
 * the rest are well-known tech companies added by hand. A board that later
 * disappears just fails its checks and backs off; remove it here when you
 * notice. To add boards without editing this file, list their URLs in
 * INDEX_BOARDS_FILE.
 */
const on = (base: string, slugs: string) => slugs.split(/\s+/).filter(Boolean).map((slug) => `${base}${slug}`);

const GREENHOUSE = on(
  'https://boards.greenhouse.io/',
  `1910genetics abnormalsecurity aceable aclu adyen affirm agency agoda airbnb airtable akidolabs albedo algolia alloy alpaca andurilindustries
   ansabiotechnologies anthropic aon3d apolloio apptronik asana assemblyai astranis attain attentive axial axiom baubap beam betterment bigid billcom
   bird bitgo bitmovin block blockchain braze brex bugcrowd burnt cabify calendly calm camp carbonchain carrotfertility carta checkr chime clara clear
   cloudflare cloverhealth coast cockroachlabs coinbase colabsoftware collectivehealth collibra consensys contentful cortex coursera courtyardinc cribl
   cultureamp culturebiosciences databricks datadog dataiku daybreakhealth deliveroo diligent discord doordashusa dots doximity dremio dropbox duolingo
   earnin elastic elite enveritas epicgames everlaw faire fanduel fastly feanixbiotechnologies figma fireblocks fivetran flatironhealth flex flexport
   flyzipline focalsystems forward freenome gemini generallegalllp generalproximity getyourguide gigs ginkgobioworks gitlab givecampus goatgroup
   gocardless gofundme golf grafanalabs greenhouse grey groww guild gusto hackerrank haven hazel heartaerospace hightouch homelight honeycomb honor
   hubblenetwork hubspotjobs humaninterest icarus imply instacart instawork intercom inversionspace juno justworks kayak kernalbio khanacademy kite
   klaviyo komodohealth laika lattice launchdarkly legalist life360 limrun ltse lucidbots lucidmotors lumahealth luminate lyft marqvision mattermost
   mavenclinic maymobility medium meruhealth mixpanel modernhealth momentus mongodb monzo moonshot n26 nabis natera navierai neo4j netlify neuralink
   newrelic nextdoor niraenergy novacredit nuro observeai odeko oklo okta omadahealth onemedical openwork ophelia orbitaloperations orcasecurity
   orchestra oscar osmosis oura overwatch pacaso pagerduty pairteam papa parsleyhealth paveakatroveinformationtechnologies pelago peloton pendo pinterest
   planetlabs planetscale plume podium81 porter postscript prodigal prolific pronto prospa pumpcareers purestorage qualtrics qventus radar raven
   razorpaysoftwareprivatelimited recidiviz recursionpharmaceuticals reddit reflex relativity remoracarbon riotgames ripple robinhood roblox roku roofr
   rosebud rubrik salesloft saltsecurity samsara scaleai seer sendbird sensei sentinellabs si sigmacomputing singlestore sirum sixfold smartasset
   smartsheet sofi sourcegraph91 spaceium squarespace stackadapt stage starburst stripe submittable sumologic superapp superset swayable swiftskuinc
   swordhealth symphony tailscale talkspace tanium taskrabbit tempo tesseract tester tia tintai toast tripadvisor trivago truveta twilio twistbioscience
   twitch udemy understoodcare upstart upwork usenourish usergems veracyte vercel veriff verkada via waymo webflow whitespace wise wizinc wolt workato
   xendit yext yugabyte yuma zerocater zocdoc zoominfo zscaler zuora`,
);

const LEVER = on(
  'https://jobs.lever.co/',
  `aircall anchorage binance biorender bloom blue bolster canarytechnologies captivateiq cents Cofactr CollectlyInc copia coupa crypto culdesac dnb doola
   easypost-2 emilabs epsilon3 fampay Farcast finch findem finix finn fintual fleetzero getzuma gopuff greenlight gridware handoff hive houzz Instrumentl
   jamcity jitxinc jobvite jumpcloud kabam kinter levelai livingcarbon lucidworks mashgin matchgroup maverickx meesho metabase multiplylabs mytos neon
   netomi newton nium olo openx Osmind outreach palantir pattern paytm people-ai picktrace pipedrive plexus plume postera pyka reachpower revi rigetti ro
   rover sapling secureframe shieldai shiru sila skyways smartcuts snappr sonatype spotify starkbank suger superside synapticure sysdig tala tendo
   Termius text theathletic thunkable toptal tovala trellis tryjeeves twodots unusual veepee veeva verifiable vida voltalabs wealthfront zerotier zippi
   zoox`,
);

const ASHBY = on(
  'https://jobs.ashbyhq.com/',
  `1password 9-mothers abacum abridge abundant accord adaptyv AfterQuery Agave agent agentmail aios aiprise airbyte airgoods airwallex alchemy aleph
   alexai ambiencehealthcare ambient.ai ambition Ambral amplitude andromedasurgical anglehealth Anima answerthis anthrogen anyscale apolink
   apollo-graphql aqua-voice aragorn archil argon-ai arini arketa ARQ artie artisan artosai ashby ashby-embed-demo-org asimov aspora assemble assembly
   Astro-Mechanica astronomer athena-hq atlas atob atomic atomic-invest atrato attio auctor aurelian aurorasolar authzed automat avallon avoca Axel
   axle-health axleinsure bankjoy base-power baseten belvo benchling benepass beparallel bernard beyondreachlabs bild-ai billiontoone birdie Blacksmith
   bland Blee blissway blueberrypediatrics bluedot bolna boom boostly bootloop brainbaselabs bree brettonai broccoli browserbase bunkerhillhealth butter
   camber cambio Cambly campfire candidhealth capimoney capy cardboard caremessage caribou casca casco castle cedar centralize character charge-robotics
   chariot chestnut chronicle-labs cinder circleback circuithub claim-health claimsorted clarion ClassDojo claylabs clearly-ai clerk clipboard Close
   codes-health cognition cohere column comena commodityai Commure complete complir concourse conductor conduit confido confluent constellation context
   conveo convex-dev Coperniq corgi corvus-robotics cosine cosmic-robotics cranston craze credal crusoe ctgt curri cursor darwin datafold dataleap
   david-ai decagon decodahealth dedalus-labs Deepgram deepnote depot DiligenceSquared dispatch ditto dmodel docker domu doppler double doublezero
   dovetail duffel dust dyneti e2b eightsleep ekho electricair elevenlabs ello eloquentai elyos emberai empirical encord Enode escape event-horizon-labs
   eventual every-io exa extend f2-ai farel fathom.video fazeshift fernstone fieldguide finary finni-health FINNY finto firecrawl firstwork flagright.com
   flai fleek fleetline fleetworks flint flip float flowtel FlutterFlow flux formal formance formenergy fortuna-health found foundation freshpaint
   frontcareers fulcrum-inc furtherai fuse gamma garage gecko-robotics getsquire gigaml glide glimpse golinks goteleport govdash GovEagle granola
   Greenboard greptile gumloop halluminate happl happyrobot.ai harperinsure harvey healthsherpa Healthtech-1 hedge helion herondata hex hexa hightouch
   hillclimb hive.co hivehealth hockeystack homebase honeydew hopper hotplate hudu humaans humanarchive humanly Hyperbound hypercore hypercubic
   hyperspell idler infera infinite infisical Influxdata inkeep innate inngest InscribeAI interfere intrinsic-safety invert invopop ironcladhq
   jeevyfabrication Jerry.ai jiga juicebox julius junction kalshi Kastle kernel Kingdom kivo-health knock kodex kombo kraken.com lago lambda laminar-jobs
   lance lancedb langchain langdock Lapel lark latent legionhealth legora lemfi lemonade lightdash linear lingodotdev litellm litmus liveflow loula lucis
   lumaai luminai mach9 madrone magicpatterns malga mangodesk marble Mastra maven meadow mednet mem0 mercura mesh metal metal.so method meticulous
   metriport middesk minerva mintlify miro misolabs modal moderntreasury modus momentic morpho mosaic moss motherduck multiverse mundo-ai mural Mutiny
   mux nabla Nango nash neon nomic notabene notion novel novig novo nowadays nox-metals numeral odys-aviation offdeal offstream ollama onebrief
   onechronos oneleet onerobot oneschema openai opencall opensea orca oso outrival outschool outset overview padlet paradigmai paragon parallel
   pax-historia Pear-VC permitflow permutive perplexity persona Pharos phasebiolabs phoenix phonely photoroom physicalintelligence pika pinecone pipekit
   pirros pivotrobotics plaid plain plane ployai PointOne polar polymath poolside popl posh posthog powerus prefect prelim prism probablygenetic
   prometheus Promise proofofhuman prose prosper-ai provision pulse pure pylon pylon-labs quicknode quindar quippy quora radiant railway Raindrop
   rallyuxr ramp reacher readme ready realitydefender Recall reducto regent relace relay render replit replo rescale resend retell-ai revenuecat
   reviserobotics rezi river rivet rivia roboflow rollstack runa runway rutter ryvn safetykit sagecare SalesPatriot salient sapien sardine saronic
   sauna.ai sazabi scape ScribdInc semgrep serifhealth sf-tensor shadeform shapescale shepherd ShortStory sidekick sierra sieve sift SigNoz sim simetrik
   simple-ai simplify skydio skydropx slash-financial slope snackpass snapdocs snapmagic snowflake snyk socket socure sola solidroad solva
   solveintelligence sorcerer spade span speak spellbrush Sphere spherecast Sphinx spotlight sprig spruceid stable stacker Stepful stilta stradahq
   stratum-ai stream subsets substack substrate suno sunset supabase svix sweep switchboard sygaldry-technologies synthesia tailor tajir taktile
   tamarindbio tank-payments tavus tekton-dynamics telli tempo temporal tennr tenor terminal the-token-company thera thndr thundercompute tilt titan toku
   topline-pro tremendous triggerdev triomics trm-labs truelinkfinancial tsenta tuesday-labs turion-space twenty ultra unify uniswap unit universe
   upcodes upflow uplane usul vanta vapi vector verahealth verge-genomics veritus versemedical verto Vetcove vibe vitable vitalize voize vooma Vori
   vorticity wafer wallbit warp watershed weave weave-os weaviate within.ai workos writer ycombinator yotta zapier zed zeit-ai zensors ziina zip`,
);

const WORKABLE = on(
  'https://apply.workable.com/',
  `aerones hokali huggingface intellecthq nalamoney open-252 ottimate platzi povio riot sorting-robotics tetrascience weekday-1 writesonic`,
);

export const BOARDS: readonly string[] = [...GREENHOUSE, ...LEVER, ...ASHBY, ...WORKABLE];
