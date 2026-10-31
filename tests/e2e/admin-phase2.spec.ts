import { expect, test, type Page } from "@playwright/test";

const username = process.env.AGORA_ADMIN_USERNAME ?? "admin";
const password = process.env.AGORA_ADMIN_PASSWORD;

const PAGES = ["/admin/raspored", "/admin/troskovi", "/admin/poslovi"];

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow, "page must not scroll horizontally").toBe(false);
}

async function login(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByLabel("Korisničko ime").fill(username);
  await page.getByLabel("Lozinka").fill(password as string);
  await page.getByRole("button", { name: "Prijavi se" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test.describe("administracija, druga faza: anonimni pristup", () => {
  for (const path of PAGES) {
    test(`${path} šalje anonimnog posetioca na prijavu`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login/);
    });
  }
});

test.describe("administracija, druga faza", () => {
  test.skip(!password, "AGORA_ADMIN_PASSWORD nije postavljen; preskačem prijavu.");

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("pregled ima kartice Budžet i Raspoređivač i veze ka novim stranicama", async ({
    page,
  }) => {
    await expect(page.getByRole("heading", { name: "Budžet", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Raspoređivač", exact: true }),
    ).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Administracija" });
    for (const label of ["Raspored", "Troškovi", "Poslovi"]) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
    await expectNoHorizontalScroll(page);
  });

  test("raspored: stanje, pregled sa rastavljenom ocenom, krugovi i odluke", async ({
    page,
  }) => {
    await page.goto("/admin/raspored?vreme=2026-11-02T10:00:00%2B01:00");
    await expect(page.getByRole("heading", { name: "Raspored", level: 1 })).toBeVisible();
    await expect(page.getByText("Budžetska faza:")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pregled sledećeg kruga" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Poslednji krugovi" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Poslednje odluke" })).toBeVisible();
    await expect(page.getByText("(zadato vreme)")).toBeVisible();

    const details = page.locator("details").filter({ hasText: "Rastavljanje ocene" }).first();
    await expect(details).toBeVisible();
    await details.locator("summary").click();
    await expect(details.getByRole("columnheader", { name: "Doprinos" })).toBeVisible();
    await expect(details.getByRole("columnheader", { name: "Faktor" })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("raspored: neispravno ili predaleko vreme se odbija uz obaveštenje", async ({
    page,
  }) => {
    await page.goto("/admin/raspored?vreme=2031-01-01T10:00:00%2B01:00");
    await expect(page.getByRole("status").filter({ hasText: "nije prihvaćeno" })).toBeVisible();
    await expect(page.getByText("(sada)")).toBeVisible();
  });

  test("troškovi: faza, dnevna i mesečna granica prema aktivnom preset-u", async ({ page }) => {
    await page.goto("/admin/troskovi");
    await expect(page.getByRole("heading", { name: "Troškovi", level: 1 })).toBeVisible();
    await expect(page.getByText(/Faza: (normalno|smanjeno|minimalno|pauzirano)/)).toBeVisible();

    const presetText = await page.getByText(/^preset: /).innerText();
    const limits = presetText.includes("quiet")
      ? ["0,2300 USD", "7,0000 USD"]
      : ["0,5000 USD", "15,0000 USD"];
    await expect(page.getByTestId("cost-day")).toContainText(limits[0]!);
    await expect(page.getByTestId("cost-month")).toContainText(limits[1]!);
    await expect(page.getByTestId("cost-day")).toContainText("Preostalo");

    await expect(page.getByRole("heading", { name: "Poslednjih 50 poziva" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cenovnik" })).toBeVisible();
    await expect(page.getByText("ne naplaćuje ništa")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("poslovi: tabela redova ili obaveštenje da radnik nije pokrenut", async ({ page }) => {
    await page.goto("/admin/poslovi");
    await expect(page.getByRole("heading", { name: "Poslovi", level: 1 })).toBeVisible();
    const queues = page.getByRole("region", { name: "Redovi poslova" });
    const notice = page.getByText("Radnik još nije pokrenut.");
    await expect(queues.or(notice).first()).toBeVisible();
    if (await queues.isVisible()) {
      await expect(queues.getByRole("columnheader", { name: "Aktivno" })).toBeVisible();
      await expect(queues.getByText("action-thread")).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: /Preskočene odluke/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /mrtvom|odustao/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
