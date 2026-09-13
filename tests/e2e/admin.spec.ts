import { expect, test } from "@playwright/test";

const username = process.env.AGORA_ADMIN_USERNAME ?? "admin";
const password = process.env.AGORA_ADMIN_PASSWORD;

test.describe("administracija", () => {
  test.skip(!password, "AGORA_ADMIN_PASSWORD nije postavljen; preskačem prijavu.");

  test("pogrešna lozinka ne prolazi, ispravna otvara pregled, karantin i odjavu", async ({
    page,
  }) => {
    await page.goto("/admin/login");
    await page.getByLabel("Korisničko ime").fill(username);
    await page.getByLabel("Lozinka").fill("pogresna-lozinka-123");
    await page.getByRole("button", { name: "Prijavi se" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Neispravno" })).toBeVisible();

    // React resets the form after a server action; the username must survive that.
    await expect(page.getByLabel("Korisničko ime")).toHaveValue(username);
    await page.getByLabel("Lozinka").fill(password as string);
    await page.getByRole("button", { name: "Prijavi se" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Pregled" })).toBeVisible();
    await expect(page.getByText("Akcije aktivne")).toBeVisible();

    await page.goto("/admin/karantin");
    await expect(page.getByText("language_english").first()).toBeVisible();
    await expect(page.getByText("no_topical_marker").first()).toBeVisible();
    await expect(page.getByText("mixed_script").first()).toBeVisible();

    await page.goto("/admin/konfiguracija");
    await expect(page.getByRole("heading", { name: "Konfiguracija" })).toBeVisible();
    await expect(page.getByText("aktivna", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Odjava" }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
