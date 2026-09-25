/**
 * Major wars from antiquity to the present, with the strategies that defined
 * them and key battles placed on the map. Years are negative for BC. A war
 * marked ongoing was still being fought at the time this list was written
 * (2025); the timeline says to check current reporting.
 *
 * Colour follows the era (see ERAS); the live Wikidata layer adds every
 * battle with coordinates for the years being viewed.
 */

export const ERAS = [
  { id: 'ancient', label: 'ancient', from: -3000, to: 499, color: '#C9A227' },
  { id: 'medieval', label: 'medieval', from: 500, to: 1499, color: '#8E7CC3' },
  {
    id: 'early-modern',
    label: 'early modern',
    from: 1500,
    to: 1799,
    color: '#5DADE2',
  },
  {
    id: 'nineteenth',
    label: '19th century',
    from: 1800,
    to: 1913,
    color: '#48C9B0',
  },
  {
    id: 'world-wars',
    label: 'world wars',
    from: 1914,
    to: 1945,
    color: '#E74C3C',
  },
  { id: 'cold-war', label: 'cold war', from: 1946, to: 1991, color: '#F39C12' },
  {
    id: 'contemporary',
    label: 'since 1992',
    from: 1992,
    to: 9999,
    color: '#EC407A',
  },
];

export function eraOf(year) {
  return ERAS.find((e) => year >= e.from && year <= e.to) || ERAS.at(-1);
}

const B = (name, year, lat, lon) => ({ name, year, lat, lon });

/** [name, start, end (null = ongoing), type, sides, strategies, battles] */
const RAW = [
  [
    'Greco-Persian Wars',
    -499,
    -449,
    'interstate',
    'Greek city-states vs the Achaemenid Persian Empire',
    'hoplite phalanx at close quarters; Themistocles builds a trireme fleet and wins at sea; Persia relies on scale, logistics and combined arms',
    [
      B('Marathon', -490, 38.118, 23.978),
      B('Thermopylae', -480, 38.796, 22.536),
      B('Salamis', -480, 37.95, 23.57),
      B('Plataea', -479, 38.21, 23.27),
    ],
  ],
  [
    'Peloponnesian War',
    -431,
    -404,
    'interstate',
    'Athens and the Delian League vs Sparta and the Peloponnesian League',
    'Pericles avoids land battle and relies on sea power and walls; Sparta ravages Attica; the Sicilian Expedition overreaches; Persian gold builds Sparta a navy',
    [B('Syracuse', -413, 37.07, 15.28), B('Aegospotami', -405, 40.33, 26.55)],
  ],
  [
    'Wars of Alexander the Great',
    -336,
    -323,
    'conquest',
    'Macedon vs the Persian Empire and Indian kingdoms',
    'combined arms — the phalanx pins, the Companion cavalry strikes the decisive point ("hammer and anvil"); speed and siegecraft',
    [
      B('Issus', -333, 36.84, 36.2),
      B('Tyre', -332, 33.27, 35.2),
      B('Gaugamela', -331, 36.36, 43.25),
      B('Hydaspes', -326, 32.9, 73.7),
    ],
  ],
  [
    'Punic Wars',
    -264,
    -146,
    'interstate',
    'Rome vs Carthage',
    'Rome builds a navy with boarding bridges; Hannibal crosses the Alps and envelops at Cannae; Fabius wears him down by avoiding battle; Scipio carries the war to Africa',
    [
      B('Cannae', -216, 41.306, 16.132),
      B('Zama', -202, 36.3, 9.4),
      B('Carthage', -146, 36.85, 10.32),
    ],
  ],
  [
    'Gallic Wars',
    -58,
    -50,
    'conquest',
    'Rome under Caesar vs Gallic tribes',
    'rapid marches, divide-and-rule alliances, field engineering; double siege lines (circumvallation) at Alesia',
    [B('Alesia', -52, 47.537, 4.5)],
  ],
  [
    'Mongol conquests',
    1206,
    1368,
    'conquest',
    'the Mongol Empire vs states across Eurasia',
    'mounted archers, feigned retreats, decimal organisation, intelligence and terror; captured engineers for sieges',
    [
      B('Mohi', 1241, 47.93, 20.93),
      B('Siege of Baghdad', 1258, 33.31, 44.36),
      B('Ain Jalut', 1260, 32.55, 35.35),
    ],
  ],
  [
    'Crusades',
    1096,
    1291,
    'religious',
    'Latin Christian states vs Muslim powers in the Levant',
    'sieges and castle networks; heavy cavalry charges; Saladin cuts the crusaders from water at Hattin',
    [
      B('Siege of Jerusalem', 1099, 31.778, 35.235),
      B('Hattin', 1187, 32.8, 35.45),
      B('Siege of Acre', 1191, 32.93, 35.08),
      B('Fall of Acre', 1291, 32.93, 35.08),
    ],
  ],
  [
    "Hundred Years' War",
    1337,
    1453,
    'dynastic',
    'England vs France',
    'English longbows and mounted raids (chevauchées); France recovers with Joan of Arc, standing armies and gunpowder artillery',
    [
      B('Crécy', 1346, 50.25, 1.88),
      B('Poitiers', 1356, 46.64, 0.39),
      B('Agincourt', 1415, 50.463, 2.142),
      B('Orléans', 1429, 47.9, 1.91),
      B('Castillon', 1453, 44.85, -0.05),
    ],
  ],
  [
    'Fall of Constantinople',
    1453,
    1453,
    'conquest',
    'Ottoman Empire vs the Byzantine Empire',
    'massed gunpowder artillery breaches the Theodosian walls; ships hauled overland into the Golden Horn',
    [B('Constantinople', 1453, 41.02, 28.95)],
  ],
  [
    'Spanish conquest of the Aztec Empire',
    1519,
    1521,
    'conquest',
    'Spain and Indigenous allies (Tlaxcala) vs the Aztec Empire',
    "alliances with the Aztecs' enemies, steel and horses, brigantines on Lake Texcoco; smallpox devastates the defenders",
    [B('Tenochtitlan', 1521, 19.435, -99.133)],
  ],
  [
    "Thirty Years' War",
    1618,
    1648,
    'religious',
    'Protestant and Catholic states of the Holy Roman Empire, Sweden, France, Spain',
    'Gustavus Adolphus combines mobile field artillery, musketeers and cavalry; armies live off the land and devastate Central Europe',
    [
      B('White Mountain', 1620, 50.08, 14.32),
      B('Breitenfeld', 1631, 51.4, 12.38),
      B('Lützen', 1632, 51.25, 12.14),
    ],
  ],
  [
    "Seven Years' War",
    1756,
    1763,
    'world',
    'Britain and Prussia vs France, Austria and Russia',
    "Frederick's oblique order and interior lines; Britain funds allies and uses naval power to win colonies in America and India",
    [
      B('Plassey', 1757, 23.8, 88.25),
      B('Leuthen', 1757, 51.13, 16.74),
      B('Plains of Abraham', 1759, 46.8, -71.22),
    ],
  ],
  [
    'American Revolutionary War',
    1775,
    1783,
    'independence',
    'American colonies with France vs Britain',
    'Washington avoids decisive defeat and keeps the army alive; the French alliance and fleet trap Cornwallis at Yorktown',
    [
      B('Lexington and Concord', 1775, 42.449, -71.23),
      B('Saratoga', 1777, 43.0, -73.64),
      B('Yorktown', 1781, 37.238, -76.51),
    ],
  ],
  [
    'Napoleonic Wars',
    1803,
    1815,
    'interstate',
    'France vs coalitions of Britain, Austria, Prussia and Russia',
    "corps system and the central position; armies living off the land; Britain's blockade and sea control; Russia's scorched earth",
    [
      B('Trafalgar', 1805, 36.17, -6.03),
      B('Austerlitz', 1805, 49.13, 16.76),
      B('Borodino', 1812, 55.53, 35.82),
      B('Leipzig', 1813, 51.34, 12.37),
      B('Waterloo', 1815, 50.68, 4.41),
    ],
  ],
  [
    'Spanish American wars of independence',
    1808,
    1826,
    'independence',
    'independence movements vs the Spanish Empire',
    'Bolívar and San Martín move armies across the Andes; irregular llanero cavalry; British volunteers and credit',
    [
      B('Boyacá', 1819, 5.45, -73.41),
      B('Carabobo', 1821, 9.97, -68.2),
      B('Ayacucho', 1824, -13.03, -74.14),
    ],
  ],
  [
    'Opium Wars',
    1839,
    1860,
    'colonial',
    'Britain (and France) vs Qing China',
    'steam warships and gunboat diplomacy force treaty ports open',
    [B('Canton', 1841, 23.13, 113.26), B('Taku Forts', 1860, 38.97, 117.72)],
  ],
  [
    'Taiping Rebellion',
    1850,
    1864,
    'civil',
    'the Taiping Heavenly Kingdom vs the Qing dynasty',
    'mass religious mobilisation; the Qing answer with regional militias (Xiang Army) and Western-trained forces',
    [B('Nanjing', 1864, 32.06, 118.8)],
  ],
  [
    'Crimean War',
    1853,
    1856,
    'interstate',
    'Russia vs the Ottoman Empire, Britain, France and Sardinia',
    'siege and trench works at Sevastopol; railways, telegraph and war reporting arrive',
    [
      B('Alma', 1854, 44.8, 33.65),
      B('Balaclava', 1854, 44.52, 33.6),
      B('Sevastopol', 1855, 44.6, 33.53),
    ],
  ],
  [
    'American Civil War',
    1861,
    1865,
    'civil',
    'the Union vs the Confederacy',
    "Anaconda Plan blockade and control of the Mississippi; railroads and rifled muskets; Sherman's march makes it total war",
    [
      B('Fort Sumter', 1861, 32.75, -79.87),
      B('Antietam', 1862, 39.47, -77.74),
      B('Gettysburg', 1863, 39.81, -77.23),
      B('Vicksburg', 1863, 32.35, -90.88),
      B('Appomattox', 1865, 37.38, -78.8),
    ],
  ],
  [
    'Franco-Prussian War',
    1870,
    1871,
    'interstate',
    'Prussia and German states vs France',
    'general staff planning and railway mobilisation; encirclement (Kesselschlacht) at Sedan; siege of Paris',
    [B('Sedan', 1870, 49.7, 4.94), B('Siege of Paris', 1871, 48.86, 2.35)],
  ],
  [
    'Anglo-Zulu War',
    1879,
    1879,
    'colonial',
    'Britain vs the Zulu Kingdom',
    'the Zulu "horns of the buffalo" envelopment wins at Isandlwana; British firepower and fortified positions prevail',
    [
      B('Isandlwana', 1879, -28.36, 30.65),
      B("Rorke's Drift", 1879, -28.35, 30.54),
      B('Ulundi', 1879, -28.33, 31.42),
    ],
  ],
  [
    'Second Boer War',
    1899,
    1902,
    'colonial',
    'Britain vs the South African Republic and Orange Free State',
    'Boer mounted commandos and marksmanship, then guerrilla war; British blockhouses, farm burning and concentration camps',
    [
      B('Spion Kop', 1900, -28.65, 29.52),
      B('Siege of Mafeking', 1900, -25.85, 25.64),
    ],
  ],
  [
    'Russo-Japanese War',
    1904,
    1905,
    'interstate',
    'Japan vs Russia',
    'surprise naval attack, siege of Port Arthur, crossing the T at Tsushima; trench and machine-gun warfare foreshadow 1914',
    [
      B('Port Arthur', 1904, 38.81, 121.26),
      B('Mukden', 1905, 41.8, 123.4),
      B('Tsushima', 1905, 34.5, 129.8),
    ],
  ],
  [
    'World War I',
    1914,
    1918,
    'world',
    'the Allies (France, Britain, Russia, Italy, United States…) vs the Central Powers (Germany, Austria-Hungary, Ottoman Empire, Bulgaria)',
    'Schlieffen Plan, then trench deadlock and attrition; blockade and unrestricted submarine warfare; by 1918 combined arms with tanks, aircraft and infiltration tactics',
    [
      B('Marne', 1914, 48.95, 3.3),
      B('Gallipoli', 1915, 40.23, 26.28),
      B('Verdun', 1916, 49.16, 5.39),
      B('Somme', 1916, 50.0, 2.7),
      B('Jutland', 1916, 56.7, 5.9),
      B('Amiens', 1918, 49.89, 2.3),
    ],
  ],
  [
    'Russian Civil War',
    1917,
    1922,
    'civil',
    'the Bolshevik Red Army vs the White movement and others',
    'interior lines and railways, armoured trains, political commissars; foreign intervention fails to decide it',
    [B('Tsaritsyn', 1918, 48.7, 44.5), B('Perekop', 1920, 46.15, 33.7)],
  ],
  [
    'Chinese Civil War',
    1927,
    1949,
    'civil',
    'the Communist Party vs the Kuomintang',
    "people's war from rural base areas; the Long March; then large conventional campaigns (Liaoshen, Huaihai)",
    [B("Yan'an", 1935, 36.6, 109.5), B('Huaihai', 1948, 34.2, 117.2)],
  ],
  [
    'Spanish Civil War',
    1936,
    1939,
    'civil',
    'Nationalists (with Germany and Italy) vs Republicans (with Soviet aid and International Brigades)',
    'foreign intervention; terror bombing of towns; a proving ground for tactics used in 1939',
    [
      B('Madrid', 1936, 40.42, -3.7),
      B('Guernica', 1937, 43.31, -2.68),
      B('Ebro', 1938, 41.1, 0.5),
    ],
  ],
  [
    'World War II',
    1939,
    1945,
    'world',
    'the Allies (United Kingdom, Soviet Union, United States, China, France…) vs the Axis (Germany, Japan, Italy…)',
    'blitzkrieg armoured breakthroughs; Soviet deep battle; strategic bombing; carrier war and island hopping; amphibious invasions; codebreaking; atomic bombs',
    [
      B('Invasion of Poland', 1939, 52.23, 21.01),
      B('Battle of France', 1940, 49.7, 4.94),
      B('Battle of Britain', 1940, 51.5, -0.12),
      B('Pearl Harbor', 1941, 21.36, -157.95),
      B('Midway', 1942, 28.2, -177.37),
      B('El Alamein', 1942, 30.83, 28.95),
      B('Stalingrad', 1942, 48.71, 44.51),
      B('Kursk', 1943, 51.73, 36.19),
      B('Normandy', 1944, 49.34, -0.6),
      B('Iwo Jima', 1945, 24.78, 141.32),
      B('Berlin', 1945, 52.52, 13.4),
      B('Hiroshima', 1945, 34.39, 132.45),
    ],
  ],
  [
    'First Indochina War',
    1946,
    1954,
    'independence',
    'the Viet Minh vs France',
    'guerrilla war becoming conventional; artillery hauled into the hills to besiege Dien Bien Phu',
    [B('Dien Bien Phu', 1954, 21.39, 103.02)],
  ],
  [
    'Arab-Israeli wars',
    1948,
    1973,
    'interstate',
    'Israel vs Arab states (Egypt, Syria, Jordan and others)',
    'pre-emptive air strike and armoured manoeuvre in 1967; in 1973 a surprise canal crossing under a missile umbrella, then Israeli counter-crossing',
    [
      B('Sinai', 1967, 30.0, 33.8),
      B('Golan Heights', 1967, 33.0, 35.75),
      B('Suez Canal crossing', 1973, 30.5, 32.35),
    ],
  ],
  [
    'Korean War',
    1950,
    1953,
    'interstate',
    'North Korea and China vs South Korea and a UN coalition led by the United States',
    'the Pusan perimeter holds; amphibious envelopment at Inchon; Chinese intervention with massed infantry; stalemate near the 38th parallel',
    [
      B('Pusan Perimeter', 1950, 35.18, 129.08),
      B('Inchon', 1950, 37.46, 126.6),
      B('Chosin Reservoir', 1950, 40.5, 127.3),
    ],
  ],
  [
    'Algerian War',
    1954,
    1962,
    'independence',
    'the FLN vs France',
    'urban and rural insurgency; French counterinsurgency by grid control (quadrillage), border barriers and torture',
    [B('Algiers', 1957, 36.75, 3.06)],
  ],
  [
    'Vietnam War',
    1955,
    1975,
    'civil',
    'North Vietnam and the Viet Cong vs South Vietnam and the United States',
    'guerrilla war supplied by the Ho Chi Minh Trail; US attrition, search and destroy and air campaigns; the Tet Offensive turns opinion',
    [
      B('Ia Drang', 1965, 13.6, 107.7),
      B('Khe Sanh', 1968, 16.63, 106.73),
      B('Hue (Tet)', 1968, 16.46, 107.59),
      B('Fall of Saigon', 1975, 10.78, 106.7),
    ],
  ],
  [
    'Soviet-Afghan War',
    1979,
    1989,
    'intervention',
    'the Soviet Union and Afghan government vs the mujahideen',
    'mujahideen guerrilla war from mountain sanctuaries with foreign supply (Stinger missiles); Soviet counterinsurgency and air power',
    [B('Kabul', 1979, 34.53, 69.17), B('Panjshir', 1984, 35.3, 69.5)],
  ],
  [
    'Iran-Iraq War',
    1980,
    1988,
    'interstate',
    'Iraq vs Iran',
    'trench warfare and human-wave assaults; chemical weapons; the Tanker War in the Gulf',
    [
      B('Khorramshahr', 1982, 30.44, 48.17),
      B('Basra', 1987, 30.5, 47.8),
      B('Halabja', 1988, 35.18, 45.99),
    ],
  ],
  [
    'Falklands War',
    1982,
    1982,
    'interstate',
    'the United Kingdom vs Argentina',
    'an expeditionary task force 12,000 km from home; submarine sinks the Belgrano; amphibious landing at San Carlos',
    [
      B('Goose Green', 1982, -51.82, -58.97),
      B('Stanley', 1982, -51.69, -57.86),
    ],
  ],
  [
    'Gulf War',
    1990,
    1991,
    'interstate',
    'a US-led coalition vs Iraq',
    'a 38-day air campaign with precision weapons, then the "left hook" armoured envelopment through the desert',
    [B('Khafji', 1991, 28.42, 48.49), B('Kuwait City', 1991, 29.37, 47.98)],
  ],
  [
    'Yugoslav Wars',
    1991,
    2001,
    'civil',
    'successor states and ethnic forces of former Yugoslavia; NATO in 1995 and 1999',
    'sieges of cities, ethnic cleansing; NATO air campaigns in Bosnia and Kosovo',
    [
      B('Vukovar', 1991, 45.35, 19.0),
      B('Sarajevo', 1992, 43.86, 18.41),
      B('Srebrenica', 1995, 44.1, 19.3),
      B('Kosovo', 1999, 42.66, 21.16),
    ],
  ],
  [
    'Rwandan Civil War',
    1990,
    1994,
    'civil',
    'the Rwandan Patriotic Front vs the Rwandan government',
    'the RPF offensive ends the 1994 genocide against the Tutsi',
    [B('Kigali', 1994, -1.95, 30.06)],
  ],
  [
    'Second Congo War',
    1998,
    2003,
    'regional',
    'the DR Congo and allies (Angola, Zimbabwe, Namibia) vs rebels backed by Rwanda and Uganda',
    'many armies and militias funded by mineral extraction; the deadliest conflict since 1945, mostly through disease and hunger',
    [B('Kinshasa', 1998, -4.32, 15.31), B('Kisangani', 2000, 0.52, 25.2)],
  ],
  [
    'War in Afghanistan',
    2001,
    2021,
    'intervention',
    'the United States, NATO and the Afghan government vs the Taliban and al-Qaeda',
    'special forces and air power with the Northern Alliance; then counterinsurgency; the Taliban outlast it',
    [
      B('Tora Bora', 2001, 34.1, 70.2),
      B('Sangin', 2010, 32.07, 64.83),
      B('Fall of Kabul', 2021, 34.53, 69.17),
    ],
  ],
  [
    'Iraq War',
    2003,
    2011,
    'intervention',
    'a US-led coalition vs Iraq, then insurgents',
    '"shock and awe" and a rapid armoured thrust to Baghdad; insurgency; the 2007 surge and Sunni Awakening',
    [B('Baghdad', 2003, 33.31, 44.36), B('Fallujah', 2004, 33.35, 43.78)],
  ],
  [
    'Syrian Civil War',
    2011,
    2024,
    'civil',
    'the Assad government (with Russia and Iran) vs rebels, the SDF, and ISIS',
    'sieges and barrel bombs; Russian air campaign from 2015; the SDF with US air support defeats ISIS; the government falls in December 2024',
    [
      B('Aleppo', 2016, 36.2, 37.16),
      B('Raqqa', 2017, 35.95, 39.01),
      B('Damascus', 2024, 33.51, 36.29),
    ],
  ],
  [
    'War against the Islamic State',
    2014,
    2019,
    'insurgency',
    'Iraq, Kurdish forces, the SDF and a US-led coalition vs ISIS',
    'partner forces on the ground with coalition air power; urban battles of Mosul and Raqqa',
    [B('Mosul', 2017, 36.34, 43.13), B('Baghuz', 2019, 34.46, 40.94)],
  ],
  [
    'Yemeni Civil War',
    2014,
    null,
    'civil',
    'the Houthis vs the Yemeni government and a Saudi-led coalition',
    'Saudi-led air campaign and blockade; Houthi ballistic missiles and drones, later against shipping in the Red Sea',
    [B("Sana'a", 2014, 15.37, 44.19), B('Hodeidah', 2018, 14.8, 42.95)],
  ],
  [
    'Russo-Ukrainian War',
    2014,
    null,
    'interstate',
    'Russia vs Ukraine',
    'annexation of Crimea and war in Donbas from 2014; full-scale invasion in 2022; mass drones, precision fires and attrition; strikes on energy; naval drones in the Black Sea',
    [
      B('Crimea', 2014, 44.95, 34.1),
      B('Kyiv', 2022, 50.45, 30.52),
      B('Mariupol', 2022, 47.1, 37.55),
      B('Kherson', 2022, 46.64, 32.61),
      B('Bakhmut', 2023, 48.6, 38.0),
      B('Avdiivka', 2024, 48.14, 37.74),
    ],
  ],
  [
    'Second Nagorno-Karabakh War',
    2020,
    2020,
    'interstate',
    'Azerbaijan vs Armenia and Artsakh',
    'armed drones and loitering munitions dominate the battlefield',
    [B('Shusha', 2020, 39.76, 46.75)],
  ],
  [
    'Tigray War',
    2020,
    2022,
    'civil',
    "Ethiopia and Eritrea vs the Tigray People's Liberation Front",
    'siege and blockade of Tigray; drones; ended by the Pretoria agreement',
    [B('Mekelle', 2020, 13.5, 39.47)],
  ],
  [
    'Myanmar civil war',
    2021,
    null,
    'civil',
    'the military junta vs resistance forces and ethnic armed organisations',
    'coordinated offensives by ethnic armies and resistance forces (Operation 1027); junta air strikes',
    [B('Operation 1027 (northern Shan)', 2023, 23.0, 98.0)],
  ],
  [
    'Sudanese civil war',
    2023,
    null,
    'civil',
    'the Sudanese Armed Forces vs the Rapid Support Forces',
    'urban war in Khartoum, sieges in Darfur; drones; mass displacement and famine',
    [B('Khartoum', 2023, 15.5, 32.56), B('El Fasher', 2024, 13.63, 25.35)],
  ],
  [
    'Israel-Hamas war',
    2023,
    null,
    'interstate',
    'Israel vs Hamas and allied groups',
    'urban warfare in Gaza and its tunnels, blockade, air strikes; regional escalation with Hezbollah and Iran',
    [B('Gaza City', 2023, 31.5, 34.47), B('Rafah', 2024, 31.29, 34.25)],
  ],
];

export const WARS = RAW.map(
  ([name, start, end, type, sides, strategies, battles]) => ({
    name,
    start,
    end,
    ongoing: end === null,
    type,
    sides,
    strategies,
    battles,
    era: eraOf(start).id,
    color: eraOf(start).color,
    lat: battles.reduce((s, b) => s + b.lat, 0) / battles.length,
    lon: battles.reduce((s, b) => s + b.lon, 0) / battles.length,
  }),
);

export const formatYear = (y) => (y < 0 ? `${-y} BC` : `${y}`);

/** Wars being fought in `year` (ongoing ones up to `now`). */
export function warsAt(year, nowYear = new Date().getFullYear()) {
  return WARS.filter((w) => year >= w.start && year <= (w.end ?? nowYear));
}

/** Battles from year - span to year (the trail behind the playhead). */
export function battlesUpTo(year, span = 3) {
  const out = [];
  for (const w of WARS)
    for (const b of w.battles)
      if (b.year <= year && b.year >= year - span)
        out.push({ ...b, war: w.name, color: w.color });
  return out;
}

/** Wikidata SPARQL: battles with coordinates between two years. */
export function battleQuery(from, to, limit = 400) {
  const iso = (y) =>
    y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
  return `SELECT ?battle ?battleLabel ?date ?coord ?warLabel WHERE {
  ?battle wdt:P31/wdt:P279* wd:Q178561 ; wdt:P625 ?coord .
  { ?battle wdt:P585 ?date } UNION { ?battle wdt:P580 ?date }
  FILTER(?date >= "${iso(from)}-01-01T00:00:00Z"^^xsd:dateTime && ?date <= "${iso(to)}-12-31T23:59:59Z"^^xsd:dateTime)
  OPTIONAL { ?battle wdt:P361 ?war . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit}`;
}

export function normalizeBattles(body) {
  const seen = new Set();
  const out = [];
  for (const b of body?.results?.bindings || []) {
    const id = b.battle?.value;
    if (!id || seen.has(id)) continue;
    const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(
      b.coord?.value || '',
    );
    if (!m) continue;
    seen.add(id);
    const d = String(b.date?.value || '');
    const year = Number((/^(-?\d+)-/.exec(d) || [])[1]);
    if (!Number.isFinite(year)) continue;
    out.push({
      name: b.battleLabel?.value || 'battle',
      year,
      lat: Number(m[2]),
      lon: Number(m[1]),
      war: b.warLabel?.value || null,
      url: id.replace(
        'http://www.wikidata.org/entity/',
        'https://www.wikidata.org/wiki/',
      ),
    });
  }
  return out;
}
