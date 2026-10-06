/**
 * The built-in board directory: public job boards of companies that hire
 * developers and tech workers, from startups to large employers in every
 * industry, that Watchtower monitors on its own, so a search watch (filters,
 * no URL) has postings to match.
 *
 * 1348 boards. Every one answered its platform's public listing API with
 * open jobs when the list was last verified (2026-10-05). Most were found with
 * scripts/discover-boards.ts from the public Y Combinator company directory;
 * the rest are well-known tech companies and large employers (Fortune 500
 * and similar), found from their careers pages and Workday tenants. A board that later
 * disappears just fails its checks and backs off; remove it here when you
 * notice. To add boards without editing this file, list their URLs in
 * INDEX_BOARDS_FILE.
 */
const on = (base: string, slugs: string) => slugs.split(/\s+/).filter(Boolean).map((slug) => `${base}${slug}`);

const GREENHOUSE = on(
  'https://boards.greenhouse.io/',
  `1910genetics abnormalsecurity aceable aclu adyen affirm agency agoda airbnb airtable akidolabs akunacapital albedo algolia align alloy alpaca anaplan
   andurilindustries ansabiotechnologies anthropic aon3d apolloio applovin apptronik asana assemblyai astranis attain attentive axial axiom baubap beam
   betterment bigid billcom bird bitgo bitmovin bitwarden block blockchain braze brex bugcrowd bungie burnt cabify calendly calm camp carbonchain
   carrotfertility carta carvana chainguard checkr chime circleci clara clear cloudflare cloverhealth coast cockroachlabs coinbase colabsoftware
   collectivehealth collibra consensys contentful coreweave cortex coursera courtyardinc cribl cultureamp culturebiosciences databricks datadog dataiku
   daybreakhealth deliveroo diligent discord doordashusa dots doximity dremio dropbox duolingo earnin elastic elite enveritas epicgames everlaw faire
   fanduel fastly feanixbiotechnologies figma figureai fireblocks fiveringsllc fivetran flatironhealth flex flexport flyzipline focalsystems forward
   freenome gemini generallegalllp generalproximity getyourguide gigs ginkgobioworks gitlab givecampus gleanwork goatgroup gocardless godaddy gofundme
   golf gongio grafanalabs greenhouse grey groww guild gusto hackerrank haven hazel hearst heartaerospace hightouch homelight honeycomb honor
   hubblenetwork hubspotjobs humaninterest icarus imply instacart instawork intercom inversionspace janestreet jfrog jumptrading juno justworks kayak
   kernalbio khanacademy kite klaviyo komodohealth laika lattice launchdarkly legalist life360 limrun ltse lucidbots lucidmotors lumahealth luminate lyft
   marqvision mattermost mavenclinic maymobility medium mercury meruhealth mixpanel modernhealth momentus mongodb monzo moonshot motional mozilla n26
   nabis natera navierai neo4j netlify neuralink newrelic nextdoor nintendo niraenergy novacredit nuro observeai ocadogroup odeko oklo okta
   oldmissioncapital omadahealth onemedical openwork ophelia orbitaloperations orcasecurity orchestra oscar osmosis oura overwatch pacaso pagerduty
   pairteam papa parsleyhealth paveakatroveinformationtechnologies pelago peloton pendo pinterest planetlabs planetscale plume podium81 point72 porter
   postscript prodigal prolific pronto prospa pumpcareers purestorage qualtrics qventus radar raven razorpaysoftwareprivatelimited recidiviz
   recursionpharmaceuticals reddit reflex relativity remoracarbon riotgames ripple robinhood roblox rocketlab roku roofr rosebud rubrik salesloft
   saltsecurity sambanovasystems samsara scaleai scopely seer sendbird sensei sentinellabs si sigmacomputing singlestore sirum sixfold smartasset
   smartsheet sofi sourcegraph91 spaceium spacex squarespace stabilityai stackadapt stage starburst stripe submittable sumologic superapp superset
   swayable swiftskuinc swordhealth symphony taboola tailscale taketwo talkspace tanium taskrabbit tempo tenableinc tesseract tester thoughtworks tia
   tintai toast togetherai tripadvisor trivago truveta twilio twistbioscience twitch uberfreight udemy understoodcare upstart upwork usenourish usergems
   veracyte vercel veriff verkada via virtu voxmedia waymo webflow whitespace wikimedia wise wizinc wolt workato wrike xai xendit yext yugabyte yuma
   zerocater zetaglobal ziprecruiter zocdoc zoominfo zscaler zuora zyngacareers`,
);

const LEVER = on(
  'https://jobs.lever.co/',
  `aircall anchorage binance biorender bloom blue bolster canarytechnologies captivateiq cents Cofactr CollectlyInc copia coupa crypto culdesac dnb doola
   easypost-2 emilabs epsilon3 fampay Farcast finch findem finix finn fintual fleetzero getzuma gopuff greenlight gridware handoff hive houzz Instrumentl
   jamcity jitxinc jobvite jumpcloud kabam kinter levelai livingcarbon lucidworks mashgin matchgroup maverickx meesho metabase metlife multiplylabs mytos
   neon netomi newton nium olo openx Osmind outreach palantir pattern paytm people-ai picktrace pipedrive plexus plume postera pyka reachpower revi
   rigetti ro rover sapling secureframe shieldai shiru sila skyways smartcuts snappr sonatype spotify starkbank suger superside synapticure sysdig tala
   tendo Termius text theathletic thunkable toptal tovala trellis tryjeeves twodots unusual veepee veeva verifiable vida voltalabs wealthfront zerotier
   zippi zoox`,
);

const ASHBY = on(
  'https://jobs.ashbyhq.com/',
  `1password 9-mothers abacum abridge abundant accord adaptyv AfterQuery Agave agent agentmail aios aiprise airbyte airgoods airwallex alchemy aleph
   alexai ambiencehealthcare ambient.ai ambition Ambral amplitude andromedasurgical anglehealth Anima answerthis anthrogen anyscale apolink
   apollo-graphql applied aqua-voice aragorn archil argon-ai arini arketa ARQ artie artisan artosai ashby ashby-embed-demo-org asimov aspora assemble
   assembly Astro-Mechanica astronomer athena-hq atlas atob atomic atomic-invest atrato attio auctor aurelian aurorasolar authzed automat avallon avoca
   Axel axle-health axleinsure bankjoy base-power baseten belvo benchling benepass beparallel bernard beyondreachlabs bild-ai billiontoone birdie
   Blacksmith bland Blee blissway blueberrypediatrics bluedot bolna boom boostly bootloop brainbaselabs bree brettonai broccoli browserbase
   bunkerhillhealth butter camber cambio Cambly campfire candidhealth capimoney capy cardboard caremessage caribou casca casco castle cedar centralize
   cerebras character charge-robotics chariot chestnut chronicle-labs cinder circleback circuithub claim-health claimsorted clarion ClassDojo claylabs
   clearly-ai clerk clickhouse clickup clipboard Close codes-health cognition cohere column comena commodityai Commure complete complir concourse
   conductor conduit confido confluent constellation context conveo convex-dev Coperniq corgi corvus-robotics cosine cosmic-robotics cranston craze
   credal crusoe ctgt curri cursor darwin datafold dataleap david-ai decagon decodahealth dedalus-labs Deepgram deepnote depot DiligenceSquared dispatch
   ditto dmodel docker domu doppler double doublezero dovetail duffel dust dyneti e2b eightsleep ekho electricair elevenlabs ello eloquentai elyos
   emberai empirical encord Enode escape event-horizon-labs eventual every-io exa expensify extend f2-ai farel fathom.video fazeshift fernstone
   fieldguide finary finni-health FINNY finto firecrawl firstwork flagright.com flai fleek fleetline fleetworks flint flip float flowtel FlutterFlow flux
   formal formance formenergy fortuna-health found foundation freshpaint frontcareers fulcrum-inc furtherai fuse gamma garage gecko-robotics gen-digital
   getsquire gigaml glide glimpse golinks goteleport govdash GovEagle granola Greenboard greptile gumloop halluminate handshake happl happyrobot.ai
   harperinsure harvey healthsherpa Healthtech-1 hedge helion herondata hex hexa hightouch hillclimb hims-and-hers hive.co hivehealth hockeystack
   homebase honeydew hopper hotplate hudu humaans humanarchive humanly Hyperbound hypercore hypercubic hyperspell idler infera infinite infisical
   Influxdata inkeep innate inngest InscribeAI interfere intrinsic-safety invert invopop ironcladhq jeevyfabrication Jerry.ai jiga juicebox julius
   junction kalshi Kastle kernel Kingdom kivo-health knock kodex kombo kraken.com lago lambda laminar-jobs lance lancedb langchain langdock Lapel lark
   latent legionhealth legora lemfi lemonade lightdash linear lingodotdev litellm litmus liveflow liveramp-inc loula lovable lucis lumaai luminai mach9
   madrone magicpatterns malga mangodesk marble Mastra maven meadow mednet mem0 mercor mercura mesh metal metal.so method meticulous metriport middesk
   midjourney minerva mintlify miro misolabs modal moderntreasury modus momentic morpho mosaic moss motherduck multiverse mundo-ai mural Mutiny mux nabla
   Nango nash neon nomic notabene notion novel novig novo nowadays nox-metals nubank numeral odys-aviation offdeal offstream ollama onebrief onechronos
   oneleet onerobot oneschema openai opencall opensea orca oso outrival outschool outset overview padlet paradigmai paragon parallel pax-historia Pear-VC
   permitflow permutive perplexity persona Pharos phasebiolabs phoenix phonely photoroom physicalintelligence pika pinecone pipekit pirros pivotrobotics
   plaid plain plane ployai PointOne polar polymath poolside popl posh posthog powerus prefect prelim prism probablygenetic prometheus Promise
   proofofhuman prose prosper-ai provision pulse pure pylon pylon-labs quicknode quindar quippy quora radiant railway Raindrop rallyuxr ramp reacher
   readme ready realitydefender Recall redis reducto regent relace relay render replit replo rescale resend retell-ai revenuecat reviserobotics rezi
   river rivet rivia roboflow rollstack runa runpod runway rutter ryvn safetykit sagecare SalesPatriot salient sapien sardine saronic sauna.ai sazabi
   scape ScribdInc semgrep sentry serifhealth sf-tensor shadeform shapescale shepherd ShortStory sidekick sierra sieve sift SigNoz sim simetrik simple-ai
   simplify skydio skydropx slash-financial slope snackpass snapdocs snapmagic snowflake snyk socket socure sola solidroad solva solveintelligence
   sorcerer spade span speak spellbrush Sphere spherecast Sphinx spotlight sprig spruceid stable stacker Stepful stilta stradahq stratum-ai strava stream
   subsets substack substrate suno sunset supabase supercell surveymonkey svix sweep switchboard sygaldry-technologies synthesia tailor tajir taktile
   tamarindbio tank-payments tavus tekton-dynamics telli tempo temporal tennr tenor terminal the-token-company thera thndr thumbtack thundercompute tilt
   titan toku topline-pro tremendous triggerdev triomics trm-labs truelinkfinancial tsenta tuesday-labs turion-space twenty ultra unify uniswap unit
   universe upcodes upflow uplane usul vanta vapi vector verahealth verge-genomics veritus versemedical verto Vetcove vibe vitable vitalize voize vooma
   Vori vorticity wafer wallbit warp watershed wealthsimple weave weave-os weaviate within.ai workos writer ycombinator yotta zapier zed zeit-ai zensors
   ziina zip`,
);

const WORKABLE = on(
  'https://apply.workable.com/',
  `aerones hokali huggingface intellecthq nalamoney open-252 ottimate platzi povio riot sorting-robotics tetrascience weekday-1 writesonic`,
);

const GREENHOUSE_EU = on('https://boards.eu.greenhouse.io/', `jetbrains`);

/** Companies that run their own careers site (see extract/apple.ts and extract/google.ts). */
const OWN_SITES = ['https://jobs.apple.com/en-us/search', 'https://careers.google.com/jobs/results/'];

const SMARTRECRUITERS = on('https://jobs.smartrecruiters.com/', `Deloitte6 TheNielsenCompany WesternDigital`);

/**
 * Workday career sites, as {tenant}.wd{n}/{site}. A check reads only the
 * newest MAX_JOBS postings of a site (see extract/workday.ts), so the largest
 * of these are covered in part.
 */
const WORKDAY = `3m.wd1/Search aa.wd105/AA abbott.wd5/abbottcareers accenture.wd103/AccentureCareers adobe.wd5/external_experienced
   agilent.wd5/Agilent_Careers aig.wd1/aig allstate.wd5/allstate_careers ally.wd1/Ally alteryx.wd108/AlteryxCareers amgen.wd1/Careers
   analogdevices.wd1/External aptiv.wd5/APTIV_CAREERS astrazeneca.wd3/Careers athenahealth.wd1/External att.wd1/ATTGeneral autodesk.wd1/Ext
   bah.wd1/BAH_Jobs bakerhughes.wd5/BakerHughes barclays.wd3/External_Career_Site_Barclays baxter.wd1/baxter bdx.wd1/EXTERNAL_CAREER_SITE_USA
   bentleysystems.wd5/bentley biibhr.wd3/external blackbaud.wd1/ExternalCareers blackline.wd108/BlackLineCareers blackrock.wd1/BlackRock_Professional
   blueorigin.wd5/BlueOrigin bmo.wd3/External boeing.wd1/EXTERNAL_CAREERS bristolmyerssquibb.wd5/BMS broadcom.wd1/External_Career broadridge.wd5/Careers
   cadence.wd1/External_Careers capitalone.wd12/Capital_One cardinalhealth.wd1/EXT carmax.wd1/External carrier.wd5/jobs ccf.wd1/ClevelandClinicCareers
   cdw.wd5/Careers centene.wd5/Centene_External chevron.wd5/jobs chipotle.wd5/ChipotleCareers chrobinson.wd5/CHRobinson cibc.wd3/search
   cigna.wd5/cignacareers cisco.wd5/Cisco_Careers citi.wd5/2 cmegroup.wd1/cme_careers conocophillips.wd1/External costar.wd1/CoStarCareers
   cox.wd1/Cox_External_Career_Site_1 criteo.wd3/Criteo_Career_Site crowdstrike.wd5/crowdstrikecareers cvshealth.wd1/CVS_Health_Careers
   danaher.wd1/DanaherJobs db.wd3/DBWebsite dexcom.wd1/Dexcom dickssportinggoods.wd1/DSG dollartree.wd5/dollartreeus doubleverify.wd5/DV_Careers
   dow.wd1/ExternalCareers dowjones.wd1/Dow_Jones_Career dukeenergy.wd1/Search dxctechnology.wd1/DXCJobs ebay.wd5/apply edwards.wd5/EdwardsCareers
   elevancehealth.wd1/ANT equinix.wd1/External etsy.wd5/Etsy_Careers expedia.wd108/search factset.wd108/FactSetCareers fanniemae.wd1/FannieMaeCareers
   fedex.wd1/FXE-LAC_External_Career_Site ffive.wd5/f5jobs fifththird.wd5/53careers fis.wd5/SearchJobs fiserv.wd5/EXT flextronics.wd1/Careers
   forrester.wd501/careers fox.wd1/Domestic gartner.wd5/EXT geico.wd1/GEAS generalmotors.wd5/Careers_GM genmills.wd1/GMI_External_Careers
   gilead.wd1/gileadcareers goodrx.wd1/Careers gsk.wd5/GSKCareers guidewire.wd5/external hcahealthcare.wd3/hcacareers homedepot.wd5/CareerDepot
   hp.wd5/ExternalCareerSite hpe.wd5/Jobsathpe humana.wd5/CenterWell_External_Career_Site iheartmedia.wd5/External_iHM illumina.wd1/illumina-careers
   infosys.wd103/Simplus_Careers ing.wd3/ICSGBLCOR insulet.wd5/insuletcareers integralads.wd1/IAScareers intel.wd1/External interpublic.wd5/OMC
   intuitive.wd1/irtc_careers iqvia.wd1/IQVIA ironmountain.wd5/iron-mountain-jobs jabil.wd5/Jabil_Careers jbhunt.wd501/Careers jci.wd5/JCI
   jll.wd1/jllcareers kimberlyclark.wd1/GLOBAL kla.wd1/Search kyndryl.wd5/KyndrylProfessionalCareers labcorp.wd1/External lbg.wd3/lbg_Careers
   leidos.wd5/External lendingclub.wd1/External livenation.wd503/LNExternalSite logitech.wd5/Logitech lseg.wd3/Careers maersk.wd3/Maersk_Careers
   magna.wd3/Magna marvell.wd1/marvellcareers massmutual.wd1/MMINDCareersite mastercard.wd1/CorporateCareers mckesson.wd3/External_Careers
   medtronic.wd1/MedtronicCareers micron.wd1/External modernatx.wd1/M_tx morningstar.wd5/Americas motorolasolutions.wd5/Careers msd.wd5/SearchJobs
   mtb.wd5/MTB nasdaq.wd1/Global_External_Site nationwide.wd1/Nationwide_Career netflix.wd108/Netflix nike.wd1/nke
   northwesternmutual.wd5/CORPORATE-CAREERS novartis.wd3/Novartis_Careers nvidia.wd5/NVIDIAExternalCareerSite onehealthineers.wd3/SHSJB
   oreillyauto.wd1/oreilly otis.wd504/REC_Ext_Gateway paloaltonetworks.wd5/panwexternalcareers parsons.wd5/Search paypal.wd1/jobs
   pfizer.wd1/PfizerCareers pg.wd5/1000 philips.wd3/jobs-and-careers pitneybowes.wd1/PBCareers plains.wd1/plains pnc.wd5/External postman.wd108/careers
   prologis.wd5/Prologis_External_Careers proofpoint.wd5/proofpointcareers prudential.wd3/prudential ptc.wd1/PTC pwc.wd3/Global_Experienced_Careers
   qualys.wd5/Careers rakuten.wd1/RakutenRewards rappi.wd12/Rappi_jobs redhat.wd5/jobs regeneron.wd1/Careers relx.wd3/ElsevierJobs relx.wd3/relx
   resmed.wd3/ResMed_External_Careers riteaid.wd1/External roberthalf.wd1/RHAPACCareers roche.wd3/roche-ext
   rockwellautomation.wd1/External_Rockwell_Automation salesforce.wd12/External_Career_Site sanofi.wd3/SanofiCareers santander.wd3/SantanderCareers
   sec.wd3/Samsung_Careers shell.wd3/ShellCareers snapchat.wd1/snap snc.wd1/SNC_External_Career_Site sonos.wd1/Sonos sprinklr.wd1/careers
   statestreet.wd1/Global stellantis.wd3/External_Career_Site_ID01 stryker.wd1/StrykerCareers sunrun.wd5/Sunrun_Careers sysco.wd5/syscocareers
   tapestry.wd108/Tapestry_Careers target.wd5/targetcareers td.wd3/TD_Bank_Careers teladoc.wd503/teladochealth_is_hiring thehartford.wd5/Careers_External
   thetradedesk.wd5/TTDExternalSite thomsonreuters.wd5/External_Career_Site tiaa.wd1/Search tjx.wd1/TJX_EXTERNAL toyota.wd503/TMNA
   tranetechnologies.wd12/Trane_Technologies_Careers transunion.wd5/TransUnion travelers.wd5/External trimble.wd1/TrimbleCareers tysonfoods.wd5/TSN
   unilever.wd3/Unilever_Experienced_Professionals unum.wd1/External usaa.wd1/USAAJOBSWD usbank.wd1/US_Bank_Careers vanguard.wd5/vanguard_external
   veradigm.wd12/VR vfc.wd5/vfc_careers visa.wd5/Visa vrtx.wd501/Vertex_Careers workday.wd5/Workday workiva.wd503/careers zalando.wd3/ZalandoSiteWD
   zebra.wd501/Zebra_careers zendesk.wd1/zendesk zillow.wd5/Zillow_Group_External zoetis.wd5/zoetis`
  .split(/\s+/)
  .filter(Boolean)
  .map((s) => `https://${s.replace('/', '.myworkdayjobs.com/')}`);

export const BOARDS: readonly string[] = [...GREENHOUSE, ...GREENHOUSE_EU, ...LEVER, ...ASHBY, ...WORKABLE, ...SMARTRECRUITERS, ...WORKDAY, ...OWN_SITES];
