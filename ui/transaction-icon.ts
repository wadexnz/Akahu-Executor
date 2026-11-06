// The mobile app's transaction icons (mobile/src/utils/transactionIcon.ts): an icon per NZFCC
// category, with flow and Akahu type taking precedence.
import type { IconName } from "./icon-data.js";

// Specific categories precede broader families. Based on the public NZFCC
// taxonomy (https://nzfcc.org, 2026.07.07), plus common short category labels.
const categories = [
  [/\b(accountancy|bookkeeping|auditing)\b/i, "BriefcaseBusiness"],
  [/\b(non medical)\b/i, "FlaskConical"],
  [/\b(veterinary|pets?)\b/i, "PawPrint"],
  [/\b(childcare|child support|infant)\b/i, "Baby"],
  [
    /\b(gym|gyms|fitness|yoga|pilates|aquatic|sports?|athletic|golf)\b/i,
    "Dumbbell",
  ],
  [
    /\b(pharmac\w*|medical|health|dental|doctor\w*|physician\w*|hospital\w*|hospice\w*|physiotherapy|chiropodist\w*|podiatrist\w*|chiropractor\w*|osteopath\w*|psychology|psychiatric|counselling|optometrist\w*|eyewear)\b/i,
    "HeartPulse",
  ],
  [/\b(air transport|airports?|airlines?|flights?)\b/i, "Plane"],
  [
    /\b(hotels?|motels?|campgrounds?|holiday parks|recreational camps|motor parks)\b/i,
    "BedDouble",
  ],
  [/\b(travel|tour operators)\b/i, "Luggage"],
  [/\b(boat\w*|marinas?|marine|ferr\w*)\b/i, "Ship"],
  [/\b(bicycle\w*|cycling)\b/i, "Bike"],
  [/\b(trains?|rail)\b/i, "TrainFront"],
  [/\b(fuel|petrol|diesel)\b/i, "Fuel"],
  [/\b(electric vehicle charging)\b/i, "PlugZap"],
  [/\b(parking|toll)\b/i, "ParkingCircle"],
  [
    /\b(automotive|cars?|trucks?|motorcycle\w*|tyres?|towing|vehicle\w*|taxi|rideshare|trailer\w*)\b/i,
    "Car",
  ],
  [/\b(transport|bus|shuttle)\b/i, "Bus"],
  [/\b(coffee|caf[eé]s?)\b/i, "Coffee"],
  [/\b(baker\w*|bread)\b/i, "Croissant"],
  [
    /\b(bars?|pubs?|nightclubs?|liquor|wineries|breweries|distilleries)\b/i,
    "Wine",
  ],
  [
    /\b(grocer\w*|supermarket\w*|convenience|seafood|meat|meal kit)\b/i,
    "ShoppingBasket",
  ],
  [
    /\b(restaurants?|food|dining|takeaway\w*|caterers?|ice cream|gelato|confection\w*)\b/i,
    "Utensils",
  ],
  [/\b(internet|telecommunication\w*|broadband|phone)\b/i, "Wifi"],
  [/\b(water|waste|recycling|sanitation)\b/i, "Droplets"],
  [/\b(utilities|electricity|power|gas)\b/i, "Zap"],
  [/\b(insurance|security)\b/i, "ShieldCheck"],
  [/\b(cash|atm)\b/i, "Banknote"],
  [
    /\b(tax|government|council|rates|superannuation|social welfare)\b/i,
    "Landmark",
  ],
  [
    /\b(charit\w*|welfare|religious|donation\w*|family support)\b/i,
    "HeartHandshake",
  ],
  [/\b(debt|loan\w*|lending|credit|fees?)\b/i, "CreditCard"],
  [
    /\b(foreign exchange|money transfer|peer to peer|transfer)\b/i,
    "ArrowLeftRight",
  ],
  [
    /\b(financial|investment\w*|kiwisaver|saving\w*|dividends?|interest)\b/i,
    "Sprout",
  ],
  [
    /\b(income|salary|wages|bonuses|commissions|payouts|reimbursements|refunds?|rebates)\b/i,
    "ArrowDownLeft",
  ],
  [/\b(legal|lawyer\w*)\b/i, "Scale"],
  [/\b(courier|freight|postal|delivery)\b/i, "Package"],
  [/\b(software|cloud|computer|electronics?|appliance\w*|IT)\b/i, "Laptop"],
  [
    /\b(books?|libraries|newspapers?|magazines?|literary|stationery|printing|publishing)\b/i,
    "BookOpen",
  ],
  [/\b(education|schools?|universities|training|student)\b/i, "GraduationCap"],
  [/\b(haircuts?|hairdressing|cosmetic\w*|beauty)\b/i, "Scissors"],
  [
    /\b(apparel|accessor\w*|clothing|shoe\w*|uniforms?|fabric|sewing|knitting|laundry|drycleaning)\b/i,
    "Shirt",
  ],
  [/\b(watch|clock|jewellery|jewelry)\b/i, "Gem"],
  [
    /\b(garden\w*|nurseries|agricultural|landscaping|horticultural|floral)\b/i,
    "Flower2",
  ],
  [
    /\b(building|carpentry|concrete|electrical|floor|hardware|heating|cooling|ventilation|masonry|stonework|tiling|plastering|insulation|painting|plumbing|gasfitting|roofing|welding|fabrication|trade|repair|servicing|chemical|industrial|commercial supplies)\b/i,
    "Wrench",
  ],
  [
    /\b(rent|housing|home|household|furniture|furnishing|curtains|blinds|window|fireplaces|body corporate|retirement accommodation|real estate|storage|swimming pools|cleaning)\b/i,
    "House",
  ],
  [/\b(gaming|game\w*|toys?|hobby)\b/i, "Gamepad2"],
  [/\b(casino|lottery|gambling)\b/i, "Dices"],
  [/\b(cinemas?|movies?|streaming)\b/i, "Clapperboard"],
  [/\b(music\w*|concerts?)\b/i, "Music"],
  [/\b(photography|camera\w*)\b/i, "Camera"],
  [/\b(art|craft|galleries)\b/i, "Palette"],
  [
    /\b(entertainment|events?|tickets?|theatre|attractions?|museums?|zoos?|amusement|circuses|exhibits|lifestyle|dating)\b/i,
    "Ticket",
  ],
  [/\b(gift\w*|souvenir\w*)\b/i, "Gift"],
  [
    /\b(shopping|retail|stores?|secondhand|variety|duty free|cigarette|vape|smoking)\b/i,
    "ShoppingBag",
  ],
  [
    /\b(business|professional|advertising|marketing|employment|career|consulting|organisations|architect|engineering|surveying|funeral|memorial)\b/i,
    "BriefcaseBusiness",
  ],
] as const;

const groups = new Map<string, IconName>([
  ["professional services", "BriefcaseBusiness"],
  ["household", "House"],
  ["lifestyle", "Ticket"],
  ["appearance", "Shirt"],
  ["transport", "Bus"],
  ["food", "Utensils"],
  ["housing", "House"],
  ["education", "GraduationCap"],
  ["health", "HeartPulse"],
  ["utilities", "Zap"],
]);

export function categoryIconName(name = "", group = ""): IconName {
	const normalized = name.normalize("NFD").replace(/\p{M}/gu, "");
	return categories.find(([pattern]) => pattern.test(normalized))?.[1] ?? groups.get(group.toLowerCase()) ?? "Receipt";
}

export function transactionIconName(t: { flow?: string; type: string; category?: string; category_group?: string }): IconName {
	// Respect user rules and transfer detection, even with a merchant category.
	if (t.flow === "transfer") return "ArrowLeftRight";
	if (t.flow === "saving") return "Sprout";
	if (t.flow === "income") return "ArrowDownLeft";
	// Charges remain spending even when their category describes investments.
	if (t.type === "TAX") return "Landmark";
	if (t.type === "FEE" || t.type === "INTEREST") return "CreditCard";
	const category = categoryIconName(t.category, t.category_group);
	if (category !== "Receipt") return category;
	return t.type === "ATM" ? "Banknote" : "Receipt";
}
