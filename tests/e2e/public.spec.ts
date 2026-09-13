import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke tests against the seeded demo. They read only; nothing here can
 * trigger generation, and the admin flow lives in admin.spec.ts.
 */

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow, "page must not scroll horizontally").toBe(false);
}

test.describe("javne stranice", () => {
  test("početna: obaveštenje o AI simulaciji, tabovi, teme i iskreno stanje vesti", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Ovaj forum naseljavaju AI sagovornici").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Sortiranje" })).toBeVisible();
    const cards = page.getByRole("article");
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(3);
    await expect(page.getByText("Izvori vesti nisu konfigurisani")).toBeVisible();
    await expect(page.getByText("fikstura").first()).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByRole("link", { name: "Najnovije" }).click();
    await expect(page).toHaveURL(/sort=novo/);
    await expect(page.getByRole("article").first()).toBeVisible();
  });

  test("tema: ugnežđeni komentari, AI oznake, izvori i istorija izmena", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("link", { name: /Kako čuvate ajvar/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/t\//);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("ajvar");
    await expect(page.getByRole("region", { name: "Izvori" }).first()).toBeVisible();
    await expect(page.getByText("Istorija izmena")).toBeVisible();

    const comments = page.locator("#komentari article");
    expect(await comments.count()).toBeGreaterThanOrEqual(5);
    await expect(page.locator(".comment-branch").first()).toBeVisible();
    expect(await page.getByText("AI", { exact: true }).count()).toBeGreaterThan(3);
    await expectNoHorizontalScroll(page);

    await page.getByRole("link", { name: "Veza na komentar" }).first().click();
    await expect(page).toHaveURL(/\/t\/[0-9a-f-]+\/k\/[0-9a-f-]+/);
    await expect(page.getByRole("heading", { name: "Nastavak diskusije" })).toBeVisible();
  });

  test("pretraga daje iste rezultate za ćirilicu i latinicu", async ({ page }) => {
    await page.goto("/pretraga?q=ajvar");
    const latinFirst = await page
      .locator("section", { hasText: /^Teme \(/ })
      .getByRole("link")
      .first()
      .textContent();
    expect(latinFirst).toBeTruthy();

    await page.goto("/pretraga?q=ајвар");
    const cyrillicFirst = await page
      .locator("section", { hasText: /^Teme \(/ })
      .getByRole("link")
      .first()
      .textContent();
    expect(cyrillicFirst).toBe(latinFirst);
  });

  test("zajednice, sagovornici, izvori i o forumu", async ({ page }) => {
    await page.goto("/zajednice");
    expect(await page.getByRole("listitem").count()).toBe(10);

    await page.goto("/a");
    expect(await page.getByRole("listitem").count()).toBe(16);
    expect(await page.getByText("AI", { exact: true }).count()).toBeGreaterThanOrEqual(16);

    await page.getByRole("link", { name: "Goran iz Beča" }).click();
    await expect(page.getByText("Ovo je izmišljen AI lik")).toBeVisible();

    await page.goto("/izvori");
    await expect(page.getByRole("heading", { name: "Registar izvora" })).toBeVisible();
    await expect(page.getByText("još nije pokrenuto")).toBeVisible();

    await page.goto("/o-forumu");
    await expect(page.getByRole("heading", { name: "O forumu" })).toBeVisible();
  });

  test("tastatura: prvi Tab fokusira vezu za preskakanje", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Preskoči na sadržaj" })).toBeFocused();
  });

  test("javni posetilac ne može do administracije", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.goto("/admin/karantin");
    await expect(page).toHaveURL(/\/admin\/login/);
    const health = await page.request.get("/api/health");
    expect(health.ok()).toBe(true);
    expect((await health.json()).database).toBe("ok");
  });
});
