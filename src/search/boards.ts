/**
 * The built-in board directory: public job boards of companies that hire
 * developers and tech workers, from startups to large employers in every
 * industry, that Watchtower monitors on its own, so a search watch (filters,
 * no URL) has postings to match.
 *
 * 1528 boards. Every one answered its platform's public listing API with
 * open jobs when the list was last verified (2026-10-06). Most were found with
 * scripts/discover-boards.ts from the public Y Combinator company directory;
 * the rest are well-known tech companies and large employers (Fortune 500,
 * and the 500 largest US companies by market cap where their board is on a
 * supported platform), found from their careers pages and Workday tenants. A board that later
 * disappears just fails its checks and backs off; remove it here when you
 * notice. To add boards without editing this file, list their URLs in
 * INDEX_BOARDS_FILE.
 */
const on = (base: string, slugs: string) => slugs.split(/\s+/).filter(Boolean).map((slug) => `${base}${slug}`);

const GREENHOUSE = on(
  'https://boards.greenhouse.io/',
  `1910genetics abnormalsecurity aceable aclu adyen affirm agency agoda airbnb airtable akidolabs akunacapital albedo algolia align alloy
   alnylampharmaceuticals alpaca anaplan andurilindustries ansabiotechnologies anthropic aon3d apolloio applovin apptronik asana assemblyai asteralabs
   astranis astspacemobile attain attentive axial axiom axon baubap beam betterment bigid billcom bird bitgo bitmovin bitwarden block blockchain braze
   brex bugcrowd bungie burnt cabify calendly calm camp carbonchain carrotfertility carta carvana chainguard checkr chime circleci clara clear clever cloudflare
   cloverhealth coast cockroachlabs coinbase colabsoftware collectivehealth collibra consensys contentful coreweave cortex coupang coursera courtyardinc
   cribl cultureamp culturebiosciences databricks datadog dataiku daybreakhealth deliveroo diligent discord doordashusa dots doximity dremio dropbox
   duolingo earnin elastic elite enveritas epicgames eqtcorporation everlaw faire fanduel fastly feanixbiotechnologies figma figureai fireblocks
   fiveringsllc fivetran flatironhealth flex flexport flyzipline focalsystems forward freenome gemini generallegalllp generalproximity getyourguide gigs
   ginkgobioworks gitlab givecampus gleanwork goatgroup gocardless godaddy gofundme golf gongio grafanalabs greenhouse grey groww guild gusto hackerrank
   haven hazel hearst heartaerospace hightouch homelight honeycomb honor hubblenetwork hubspotjobs humaninterest icarus imply instacart instawork
   intercom inversionspace ionq janestreet jfrog jumptrading juno justworks kayak kernalbio khanacademy kikoff kite klaviyo komodohealth laika lattice
   launchdarkly legalist life360 limrun ltse lucidbots lucidmotors lumahealth luminate lyft marqvision mattermost mavenclinic maymobility medium mercury
   meruhealth mixpanel modernhealth momentus mongodb monsterenergy monzo moonshot motional mozilla n26 nabis natera navierai neo4j netlify neuralink
   newrelic nextdoor nintendo niraenergy novacredit nuro observeai ocadogroup odeko oklo okta oldmissioncapital omadahealth onemedical openwork ophelia
   orbitaloperations orcasecurity orchestra oscar osmosis oura overwatch pacaso pagerduty pairteam papa parsleyhealth paveakatroveinformationtechnologies
   pelago peloton pendo pinterest placerlabs planetlabs planetscale plume podium81 point72 porter postscript prodigal prolific pronto prospa pumpcareers purestorage
   qualtrics qventus radar raven razorpaysoftwareprivatelimited recidiviz recursionpharmaceuticals reddit reflex relativity remoracarbon
   revolutionmedicines riotgames ripple robinhood roblox rocketlab roku roofr rosebud rubrik salesloft saltsecurity sambanovasystems samsara scaleai
   scopely seer sendbird sensei sentinellabs sharkninjaoperatingllc si sigmacomputing singlestore sirum sixfold smartasset smartsheet sofi sourcegraph91
   spaceium spacex squarespace stabilityai stackadapt stage starburst stripe submittable sumologic superapp superset swayable swiftskuinc swordhealth
   symphony taboola tailscale taketwo talkspace tanium taskrabbit tempo tenableinc tesseract tester thoughtworks tia tintai toast togetherai tpgcareers
   tripadvisor trivago truveta twilio twistbioscience twitch uberfreight ubiquiti udemy understoodcare upstart upwork urbancompass usenourish usergems veracyte vercel
   veriff verisign verkada via virtu voxmedia waymo webflow whitespace wikimedia wise wizinc wolt workato wrike xai xendit yext yugabyte yuma zerocater
   zetaglobal ziprecruiter zocdoc zoominfo zscaler zuora zyngacareers`,
);

const LEVER = on(
  'https://jobs.lever.co/',
  `aircall anchorage binance biorender bloom blue bolster canarytechnologies captivateiq cents Cofactr CollectlyInc copia coupa crypto culdesac dnb doola
   easypost-2 emilabs epsilon3 fampay Farcast finch findem finix finn fintual fleetzero getzuma gopuff greenlight gridware handoff hive houzz Instrumentl
   ion jamcity jitxinc jobvite jumpcloud kabam kinter levelai livingcarbon lucidworks mashgin matchgroup maverickx meesho metabase metlife multiplylabs mytos
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
   assembly Astro-Mechanica astronomer athena-hq atlas atlys atob atomic atomic-invest atrato attio auctor aurelian aurorasolar authzed automat avallon avoca
   Axel axle-health axleinsure bankjoy base-power baseten beaconai belvo benchling benepass beparallel bernard beyondreachlabs bild-ai billiontoone birdie
   Blacksmith bland Blee blissway blueberrypediatrics bluedot bolna boom boostly bootloop brainbaselabs bree brettonai broccoli browserbase
   bunkerhillhealth butter camber cambio Cambly campfire candidhealth cape capimoney capy cardboard caremessage caribou casca casco castle cedar centralize
   cerebras character charge-robotics chariot chestnut chronicle-labs cinder circleback circuithub claim-health claimsorted clarion ClassDojo claylabs
   clearly-ai clerk clickhouse clickup clipboard Close codes-health cognition cohere column comena commodityai Commure complete complir concourse
   conductor conduit confido confluent constellation context conveo convex-dev Coperniq corgi corvus-robotics cosine cosmic-robotics cranston craze
   credal crusoe ctgt curri cursor darwin datafold dataleap david-ai decagon decodahealth dedalus-labs Deepgram deepnote depot DiligenceSquared dispatch
   ditto dmodel docker domu doppler double doublezero dovetail duffel dust dyneti e2b earlymedia eightsleep ekho electricair elevenlabs ello eloquentai elyos
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
   proofofhuman prose prosper-ai provision pulse pure pylon pylon-labs quicknode quindar quippy quizlet-inc quora radiant railway Raindrop rallyuxr ramp reacher
   readme ready realitydefender Recall redis reducto regent relace relay render replit replo rescale resend retell-ai revenuecat reviserobotics rezi
   river rivet rivia roboflow rollstack runa runpod runway rutter ryvn safetykit sagecare SalesPatriot salient sapien sardine saronic sauna.ai sazabi
   scape ScribdInc semgrep sentry serifhealth sesame sf-tensor shadeform shapescale shepherd ShortStory sidekick sierra sieve sift SigNoz sim simetrik simple-ai
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
  `aerones fuseenergy hokali huggingface intellecthq nalamoney open-252 ottimate platzi povio riot sorting-robotics tetrascience weekday-1 writesonic`,
);

const GREENHOUSE_EU = on('https://boards.eu.greenhouse.io/', `jetbrains`);

/** Companies that run their own careers site (see extract/apple.ts, google.ts, amazon.ts and microsoft.ts). */
const OWN_SITES = [
  'https://jobs.apple.com/en-us/search',
  'https://careers.google.com/jobs/results/',
  'https://www.amazon.jobs/en/search',
  'https://apply.careers.microsoft.com/careers',
];

const SMARTRECRUITERS = on('https://jobs.smartrecruiters.com/', `AristaNetworks Deloitte6 Expeditors MicroStrategy1 NBCUniversal3 PublicStorage ServiceNow TheNielsenCompany Wabtec WesternDigital`);

/**
 * Workday career sites, as {tenant}.wd{n}/{site}. A check reads only the
 * newest MAX_JOBS postings of a site (see extract/workday.ts), so the largest
 * of these are covered in part.
 */
const WORKDAY = `3m.wd1/Search aa.wd105/AA abbott.wd5/abbottcareers accenture.wd103/AccentureCareers adobe.wd5/external_experienced aep.wd1/AEPCareerSite
   agilent.wd5/Agilent_Careers aig.wd1/aig airproducts.wd5/AP0001 alliantenergy.wd1/alliant allstate.wd5/allstate_careers ally.wd1/Ally
   alteryx.wd108/AlteryxCareers amat.wd1/External ameren.wd1/External ameriprise.wd5/Ameriprise amgen.wd1/Careers analogdevices.wd1/External
   aptiv.wd5/APTIV_CAREERS aresmgmt.wd1/External astrazeneca.wd3/Careers athenahealth.wd1/External athene.wd5/Apollo_Careers
   atmosenergy.wd108/External_Career_Site att.wd1/ATTGeneral autodesk.wd1/Ext bah.wd1/BAH_Jobs bakerhughes.wd5/BakerHughes
   barclays.wd3/External_Career_Site_Barclays baxter.wd1/baxter bbinsurance.wd1/Careers bdx.wd1/EXTERNAL_CAREER_SITE_USA beigene.wd5/BeiGene
   bentleysystems.wd5/bentley biibhr.wd3/external blackbaud.wd1/ExternalCareers blackline.wd108/BlackLineCareers blackrock.wd1/BlackRock_Professional
   blackstone.wd1/Blackstone_Careers bloomenergy.wd1/BloomEnergyCareers blueorigin.wd5/BlueOrigin bmo.wd3/External boeing.wd1/EXTERNAL_CAREERS
   bristolmyerssquibb.wd5/BMS broadcom.wd1/External_Career broadridge.wd5/Careers burlington.wd5/BurlingtonCareers cadence.wd1/External_Careers
   capitalone.wd12/Capital_One cardinalhealth.wd1/EXT carmax.wd1/External carrier.wd5/jobs cartech.wd5/CTCExternal cat.wd5/CaterpillarCareers
   cboe.wd1/External_Career_CBOE cbrands.wd5/CBI_External_Careers ccf.wd1/ClevelandClinicCareers cdw.wd5/Careers centene.wd5/Centene_External
   cfindustries.wd1/careers chevron.wd5/jobs chipotle.wd5/ChipotleCareers chrobinson.wd5/CHRobinson churchdwight.wd1/chdcareers cibc.wd3/search
   ciena.wd5/Careers cigna.wd5/cignacareers circle.wd1/Circle cisco.wd5/Cisco_Careers citi.wd5/2 cmegroup.wd1/cme_careers cna.wd1/CNA_Careers
   coke.wd1/coca-cola-careers comcast.wd115/Comcast_Careers comfortsystemsusa.wd1/Corpcareers conocophillips.wd1/External copart.wd12/Copart
   corpay.wd103/Ext_001 corteva.wd5/Corteva costar.wd1/CoStarCareers cox.wd1/Cox_External_Career_Site_1 criteo.wd3/Criteo_Career_Site
   crowdstrike.wd5/crowdstrikecareers curtisswright.wd1/CW_External_Career_Site cvshealth.wd1/CVS_Health_Careers danaher.wd1/DanaherJobs db.wd3/DBWebsite
   dexcom.wd1/Dexcom diamondbackenergy.wd12/DBE dickssportinggoods.wd1/DSG disney.wd5/disneycareer dollartree.wd5/dollartreeus
   doubleverify.wd5/DV_Careers dover.wd103/Dover dow.wd1/ExternalCareers dowjones.wd1/Dow_Jones_Career dukeenergy.wd1/Search dupont.wd5/Jobs
   dxctechnology.wd1/DXCJobs ebay.wd5/apply ecolab.wd1/Ecolab_External edwards.wd5/EdwardsCareers elevancehealth.wd1/ANT entegris.wd1/EntegrisCareers
   equifax.wd5/External equinix.wd1/External essex.wd5/essexcareers etsy.wd5/Etsy_Careers eversource.wd1/ExternalSite expedia.wd108/search
   extraspace.wd5/ESS_External factset.wd108/FactSetCareers fanniemae.wd1/FannieMaeCareers fedex.wd1/FXE-LAC_External_Career_Site ffive.wd5/f5jobs
   fifththird.wd5/53careers fis.wd5/SearchJobs fiserv.wd5/EXT flextronics.wd1/Careers flir.wd1/flircareers formulaone.wd3/F1 forrester.wd501/careers
   fox.wd1/Domestic freight.wd108/FXF_External_Career_Site gartner.wd5/EXT gdit.wd5/External_Career_Site geaerospace.wd5/GE_ExternalSite
   gehc.wd5/GEHC_ExternalSite geico.wd1/GEAS generalmotors.wd5/Careers_GM genmills.wd1/GMI_External_Careers genpt.wd1/Careers
   gevernova.wd5/Vernova_ExternalSite gh.wd1/gh ghr.wd1/Lateral-US gilead.wd1/gileadcareers globalfoundries.wd1/External globalhr.wd5/REC_RTX_Ext_Gateway
   goodrx.wd1/Careers gsk.wd5/GSKCareers guidewire.wd5/external hcahealthcare.wd3/hcacareers hcmportal.wd5/Search heinz.wd1/KraftHeinz_Careers
   homedepot.wd5/CareerDepot hp.wd5/ExternalCareerSite hpe.wd5/Jobsathpe humana.wd5/CenterWell_External_Career_Site huntington.wd12/HNBcareers
   idexcorp.wd5/IDEX_Careers idexx.wd115/IDEXX iff.wd5/IFF_Careers iheartmedia.wd5/External_iHM illumina.wd1/illumina-careers
   infosys.wd103/Simplus_Careers ing.wd3/ICSGBLCOR insmed.wd504/EXTERNAL insulet.wd5/insuletcareers integralads.wd1/IAScareers intel.wd1/External
   interpublic.wd5/OMC intuitive.wd1/irtc_careers iqvia.wd1/IQVIA ironmountain.wd5/iron-mountain-jobs itw.wd5/External jabil.wd5/Jabil_Careers
   jbhunt.wd501/Careers jci.wd5/JCI jj.wd5/JJ jll.wd1/jllcareers kenvue.wd5/kenvue keybank.wd5/External_Career_Site kimberlyclark.wd1/GLOBAL
   kla.wd1/Search kyndryl.wd5/KyndrylProfessionalCareers labcorp.wd1/External latticesemi.wd5/latticesemiconductorscareers lbg.wd3/lbg_Careers
   leidos.wd5/External lendingclub.wd1/External lennar.wd1/Lennar_Jobs lilly.wd115/LLY livenation.wd503/LNExternalSite logitech.wd5/Logitech
   lowes.wd5/LWS_External_CS lplfinancial.wd1/External lseg.wd3/Careers lumentum.wd5/LITE maersk.wd3/Maersk_Careers magna.wd3/Magna
   markelcorp.wd5/GlobalCareers marvell.wd1/marvellcareers massmutual.wd1/MMINDCareersite mastercard.wd1/CorporateCareers mckesson.wd3/External_Careers
   mdlz.wd3/External mdtkangaroo.wd108/MiniMedCareers medline.wd5/Medline medtronic.wd1/MedtronicCareers microchiphr.wd5/External micron.wd1/External mksinst.wd1/MKSCareersAmericas
   mmc.wd1/MMC modernatx.wd1/M_tx monolithicpower.wd12/MPS_Careers morningstar.wd5/Americas motorolasolutions.wd5/Careers mpc.wd1/MPCCareers
   ms.wd5/External msd.wd5/SearchJobs mtb.wd5/MTB myhrabc.wd5/Global nasdaq.wd1/Global_External_Site nationwide.wd1/Nationwide_Career
   netflix.wd108/Netflix ngc.wd1/Northrop_Grumman_External_Site nike.wd1/nke nisource.wd1/NiSource northwesternmutual.wd5/CORPORATE-CAREERS
   novartis.wd3/Novartis_Careers ntrs.wd1/northerntrust nvidia.wd5/NVIDIAExternalCareerSite odfl.wd1/ODFL_Careers onehealthineers.wd3/SHSJB
   oneok.wd1/ONEOK oreillyauto.wd1/oreilly otis.wd504/REC_Ext_Gateway ovintiv.wd3/ovintivcareers oxy.wd5/Corporate
   paloaltonetworks.wd5/panwexternalcareers parsons.wd5/Search paypal.wd1/jobs permianres.wd12/Permian_Resources_Careers pfizer.wd1/PfizerCareers
   pg.wd5/1000 philips.wd3/jobs-and-careers pitneybowes.wd1/PBCareers plains.wd1/plains pnc.wd5/External postman.wd108/careers ppg.wd5/PPG_CAREERS
   priceline.wd1/BookingHoldings prologis.wd5/Prologis_External_Careers proofpoint.wd5/proofpointcareers prudential.wd3/prudential ptc.wd1/PTC
   pultegroup.wd1/PGI pwc.wd3/Global_Experienced_Careers qnity.wd503/Jobs qualys.wd5/Careers quickenloans.wd5/rocket_careers rakuten.wd1/RakutenRewards
   rappi.wd12/Rappi_jobs raymondjames.wd1/RaymondJamesCareers realtyincome.wd108/realty_income_careers redhat.wd5/jobs regeneron.wd1/Careers
   regions.wd5/Regions_Careers relx.wd3/ElsevierJobs relx.wd3/relx republic.wd5/Republic resmed.wd3/ResMed_External_Careers revvity.wd103/External
   rgare.wd1/Careers riteaid.wd1/External roberthalf.wd1/RHAPACCareers roche.wd3/roche-ext rockwellautomation.wd1/External_Rockwell_Automation
   salesforce.wd12/External_Career_Site sands.wd1/sands_careers sanofi.wd3/SanofiCareers santander.wd3/SantanderCareers
   sbasite.wd5/SBA_Communications_Careers sec.wd3/Samsung_Careers semtech.wd1/SemtechCareers shell.wd3/ShellCareers simon.wd1/Simon snapchat.wd1/snap
   snc.wd1/SNC_External_Career_Site sonos.wd1/Sonos spgi.wd5/SPGI_Careers sprinklr.wd1/careers statestreet.wd1/Global
   stellantis.wd3/External_Career_Site_ID01 stryker.wd1/StrykerCareers sunbeltrentals.wd1/sbcareers sunrun.wd5/Sunrun_Careers swa.wd1/external
   symbotic.wd504/Symbotic synchronyfinancial.wd5/careers synnex.wd5/tdsynnexcareers sysco.wd5/syscocareers tapestry.wd108/Tapestry_Careers
   target.wd5/targetcareers td.wd3/TD_Bank_Careers teladoc.wd503/teladochealth_is_hiring thehartford.wd5/Careers_External
   thermofisher.wd5/ThermoFisherCareers thetradedesk.wd5/TTDExternalSite thomsonreuters.wd5/External_Career_Site tiaa.wd1/Search tjx.wd1/TJX_EXTERNAL
   tmobile.wd1/External toyota.wd503/TMNA tranetechnologies.wd12/Trane_Technologies_Careers transunion.wd5/TransUnion travelers.wd5/External
   trimble.wd1/TrimbleCareers troweprice.wd5/TRowePrice truist.wd1/Careers tsys.wd1/TSYS tysonfoods.wd5/TSN
   unilever.wd3/Unilever_Experienced_Professionals unitytech.wd1/Unity unum.wd1/External ur.wd1/URcareers usaa.wd1/USAAJOBSWD usbank.wd1/US_Bank_Careers
   usfoods.wd1/usfoodscareersExternal vanguard.wd5/vanguard_external ventas.wd503/ventas_careers venturegloballng.wd108/External_Careers veradigm.wd12/VR
   veralto.wd1/VeraltoCorporateJobs verily.wd1/Verily_Careers vfc.wd5/vfc_careers viatris.wd5/External visa.wd5/Visa vrtx.wd501/Vertex_Careers vst.wd5/vistra_careers
   walmart.wd504/WalmartExternal warnerbros.wd5/global wasteconnections.wd1/Careers wf.wd1/WellsFargoJobs williams.wd5/External woodward.wd5/woodward
   workday.wd5/Workday workiva.wd503/careers wwecorp.wd5/TKO xcelenergy.wd1/External xylem.wd5/xylem-careers zalando.wd3/ZalandoSiteWD
   zebra.wd501/Zebra_careers zendesk.wd1/zendesk zillow.wd5/Zillow_Group_External zoetis.wd5/zoetis zoom.wd5/Zoom`
  .split(/\s+/)
  .filter(Boolean)
  .map((s) => `https://${s.replace('/', '.myworkdayjobs.com/')}`);

/** iCIMS portals, read from their sitemap (see extract/icims.ts). */
const ICIMS = [
  'https://careers-berkley.icims.com/jobs',
  'https://careers-eastwestbank.icims.com/jobs',
  'https://careers-emcorgroup.icims.com/jobs',
  'https://careers-quanta.icims.com/jobs',
  'https://careers-snapon.icims.com/jobs',
  'https://careers-steeldynamics.icims.com/jobs',
  'https://careersen-itt-inc.icims.com/jobs',
  'https://globalcareers-msci.icims.com/jobs',
  'https://homeoffice-na-urbn.icims.com/jobs',
  'https://uscareers-waters.icims.com/jobs',
];

/** Workday sites served from wd{n}.myworkdaysite.com instead of a tenant subdomain. */
const WORKDAY_SITE = [
  'https://wd1.myworkdaysite.com/recruiting/ssctech/SSCTechnologies',
  'https://wd5.myworkdaysite.com/recruiting/devonenergy/Careers',
  'https://wd5.myworkdaysite.com/recruiting/vhr_unither/External',
];

export const BOARDS: readonly string[] = [...GREENHOUSE, ...GREENHOUSE_EU, ...LEVER, ...ASHBY, ...WORKABLE, ...SMARTRECRUITERS, ...WORKDAY, ...WORKDAY_SITE, ...ICIMS, ...OWN_SITES];
