# Rating guide for evaluators

This guide is for the people who rate articles for Bantoozi's evaluation set (spec 10 §2). The
English version comes first; the Slovak version follows.

## English

### What this is for

Bantoozi is a feed reader that sorts articles by what you personally care about. Before it is tuned,
we need honest examples of what real readers would and would not want to read. Your ratings become
that ground truth. You never see what the model thinks, so nothing you do can be "right" or "wrong";
just answer as yourself.

### What you need

- A private link from the owner, which looks like `https://…/r?t=…`. It is personal. Do not share it
  or post it anywhere. It expires after 30 days; ask for a new one if it stops working.
- About 2–4 hours in total, in as many sittings as you like. Progress is saved on every click.
- A phone or a computer. The pages work on a 375 px wide phone screen and with a keyboard.

When you open the link, the address bar changes to a link without the token. From then on, the
browser remembers you with a cookie. Bookmark the page if you want to come back on the same device.

### Step 1: write your interests (before you see any article)

Write **5 to 10 interest cards** in your own words, in the language you prefer. Each card is one
thing you like to read about, for example "new tram and train lines in Bratislava" or "practical
TypeScript tips". Be specific, as you would explain it to a friend. For each card you can add:

- how much you care (from "nice to have" to "love it");
- what it is **not** about ("not football transfers");
- a few example headlines that fit, or do not fit.

You may also write 1–3 **"never" cards** for things you never want to see. Rating stays locked
until you have at least five interest cards. Write them before you look at articles, so the articles
do not shape what you write.

If the owner set up several reading contexts for you (for example "work" and "cooking"), each
context gets its own link and its own cards. You are still counted as one person.

### Step 2: pick feeds

Tick the feeds you would actually subscribe to. Pick **at least 10**. Only articles from these
feeds are shown to you.

### Step 3: rate

You get up to 300 articles, split evenly across your languages, in a fixed random order. For each
one you see the feed, the title, a short excerpt and an "open original" link.

- 👍 **I'd want to read this** (key `+`): you would open or save it if it appeared in your reader.
- 👎 **Not for me** (key `-`): you would scroll past it.
- Optional reason for a 👎 (keys `1`–`6`): off-topic, clickbait, seen it, too shallow, promo, other.
- **Skip** when you cannot judge it (for example a language you do not read well). A skip is not a
  dislike, and you can return to skipped articles later.
- `j` / `k` move to the next / previous article. You can change any earlier rating.

Judge the article as it is presented: would you want to read it, given its title and excerpt? Open
the original only when the excerpt is unclear. Aim for **at least 250 ratings**.

### Facet labels (owner, and optionally a second labeller)

The `/facets` page asks six questions about 100 articles per language: content type, topic, depth
(0–4), clickbait (yes/no), promotional (yes/no) and time-sensitive (yes/no). Use "uncertain" or "not
applicable" instead of guessing. A second labeller gets 50 of the same articles.

### Privacy

Ratings, cards and feed picks stay in the owner's evaluation database on the owner's computer. They
are used only to measure and tune Bantoozi. Nothing is sent to analytics or third parties, and the
pages load no external resources.

## Slovensky

### Na čo to je

Bantoozi je čítačka RSS, ktorá radí články podľa toho, čo zaujíma práve vás. Skôr ako ju vyladíme,
potrebujeme úprimné príklady toho, čo by skutoční čitatelia chceli a nechceli čítať. Vaše hodnotenia
sú tieto príklady. Nikdy neuvidíte, čo si myslí model, takže žiadna odpoveď nie je „správna“ ani
„nesprávna“. Odpovedajte jednoducho za seba.

### Čo potrebujete

- Súkromný odkaz od vlastníka v tvare `https://…/r?t=…`. Je osobný, nikomu ho neposielajte a nikde
  ho nezverejňujte. Platí 30 dní; ak prestane fungovať, vypýtajte si nový.
- Spolu asi 2–4 hodiny, rozložené do ľubovoľného počtu sedení. Každé kliknutie sa hneď uloží.
- Telefón alebo počítač. Stránky fungujú na 375 px širokom displeji aj s klávesnicou.

Po otvorení odkazu sa adresa zmení na odkaz bez tokenu. Prehliadač si vás potom pamätá pomocou
cookie. Ak sa chcete vrátiť na tom istom zariadení, uložte si stránku medzi záložky.

### Krok 1: napíšte svoje záujmy (skôr, ako uvidíte články)

Napíšte vlastnými slovami **5 až 10 kariet záujmov** v jazyku, ktorý vám vyhovuje. Každá karta je
jedna téma, o ktorej rád čítate, napríklad „nové električkové a vlakové trate v Bratislave“ alebo
„praktické tipy pre TypeScript“. Buďte konkrétni, ako keby ste to vysvetľovali kamarátovi. Ku každej
karte môžete pridať:

- ako veľmi vás téma zaujíma (od „fajn“ po „milujem“);
- čo do nej **nepatrí** („nie futbalové prestupy“);
- niekoľko príkladov titulkov, ktoré sedia alebo nesedia.

Môžete napísať aj 1–3 karty **„nikdy“** pre veci, ktoré nechcete vidieť vôbec. Hodnotenie sa
odomkne až po aspoň piatich kartách záujmov. Napíšte ich skôr, ako uvidíte články, aby vás články
neovplyvnili.

Ak vám vlastník pripravil viac kontextov čítania (napríklad „práca“ a „varenie“), každý má vlastný
odkaz a vlastné karty. Stále sa počítate ako jeden človek.

### Krok 2: vyberte zdroje

Zaškrtnite zdroje, ktoré by ste naozaj odoberali. Vyberte **aspoň 10**. Zobrazia sa vám iba články
z nich.

### Krok 3: hodnoťte

Dostanete najviac 300 článkov, rovnomerne rozdelených medzi vaše jazyky, v pevnom náhodnom poradí.
Pri každom uvidíte zdroj, titulok, krátky úryvok a odkaz „otvoriť originál“.

- 👍 **Chcel(a) by som si to prečítať** (kláves `+`): otvorili alebo uložili by ste si ho, keby sa
  objavil vo vašej čítačke.
- 👎 **Nie pre mňa** (kláves `-`): prešli by ste ďalej.
- Nepovinný dôvod pre 👎 (klávesy `1`–`6`): mimo témy, clickbait, už som videl(a), príliš plytké,
  reklama, iné.
- **Preskočiť**, ak článok neviete posúdiť (napríklad v jazyku, ktorý dobre neovládate).
  Preskočenie nie je 👎 a k preskočeným článkom sa môžete vrátiť.
- `j` / `k` presúvajú na ďalší / predchádzajúci článok. Každé skoršie hodnotenie môžete zmeniť.

Posudzujte článok tak, ako je zobrazený: chceli by ste si ho prečítať podľa titulku a úryvku?
Originál otvorte, len keď úryvok nie je jasný. Cieľ je **aspoň 250 hodnotení**.

### Označovanie vlastností (vlastník, prípadne druhý označovateľ)

Stránka `/facets` sa pri 100 článkoch v každom jazyku pýta šesť otázok: typ obsahu, téma, hĺbka
(0–4), clickbait (áno/nie), reklamný obsah (áno/nie) a časová citlivosť (áno/nie). Namiesto hádania
použite „neisté“ alebo „netýka sa“. Druhý označovateľ dostane 50 rovnakých článkov.

### Súkromie

Hodnotenia, karty a vybrané zdroje zostávajú v hodnotiacej databáze na počítači vlastníka. Používajú
sa iba na meranie a ladenie Bantoozi. Nič sa neposiela do analytiky ani tretím stranám a stránky
nenačítavajú žiadne externé zdroje.
