// Met à 0 € TOUTES les règles tarifaires d'une unité (base et saisons), et
// rend de quoi les restaurer. Sert aux tests « un prix nul ne part pas » : ne
// zéroter que la règle de base laissait passer le prix d'une saison du seed
// dès que la fenêtre testée (J+300) tombait dedans — test vert ou rouge selon
// le jour où il tourne.

export async function zeroUnitRules(db: D1Database, unitId: number): Promise<() => Promise<void>> {
  const { results } = await db
    .prepare("SELECT id, price_week_cents AS w, price_weekend_cents AS we FROM rate_rules WHERE unit_id = ?1")
    .bind(unitId)
    .all<{ id: number; w: number | null; we: number | null }>();
  await db.prepare("UPDATE rate_rules SET price_week_cents = 0, price_weekend_cents = 0 WHERE unit_id = ?1").bind(unitId).run();
  return async () => {
    for (const r of results) {
      await db
        .prepare("UPDATE rate_rules SET price_week_cents = ?2, price_weekend_cents = ?3 WHERE id = ?1")
        .bind(r.id, r.w, r.we)
        .run();
    }
  };
}
