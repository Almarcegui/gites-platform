# Intégration WordPress — moteur de réservation en iframe

Le tunnel de réservation (`/book/`) et les pages de réservation par domaine
(`/reserver/<slug>/`, cf. `docs/page-reservation-par-domaine.md`) sont les
**seules** pages du site intégrables dans une iframe : `x-frame-options: DENY` est levé uniquement pour
elles (`isEmbeddablePath` dans `src/services/http-headers.ts` côté Worker, `staticHeaders` de
`node/server.mjs` côté Node). Toutes les autres pages refusent l'intégration.

## 1. Shortcode à coller dans `functions.php` du thème (ou dans un plugin)

```php
/**
 * Intègre le moteur de réservation en iframe responsive.
 * Usage : [gites_reservation] ou [gites_reservation property="pre-more" lang="nl"]
 */
function gites_reservation_shortcode( $atts ) {
    $atts = shortcode_atts( array(
        'property' => 'pre-more',
        'lang'     => 'fr',
        'height'   => '1400',
    ), $atts, 'gites_reservation' );

    $base = 'https://lesgitesdecartier.be/book/'; // domaine définitif (01/11/2026)
    $src  = add_query_arg( array(
        'property' => $atts['property'],
        'lang'     => $atts['lang'],
    ), $base );

    return sprintf(
        '<div style="position:relative;width:100%%;padding-bottom:0;">
            <iframe src="%s" style="width:100%%;height:%spx;border:0;max-width:1100px;margin:0 auto;display:block;" loading="lazy" title="Réservation"></iframe>
        </div>',
        esc_url( $src ),
        esc_attr( $atts['height'] )
    );
}
add_shortcode( 'gites_reservation', 'gites_reservation_shortcode' );
```

## 2. Utilisation dans une page ou un article

```
[gites_reservation]
[gites_reservation property="pre-more" lang="fr" height="1600"]
```

## 3. Sans PHP : l'iframe brute

Dans un bloc **HTML personnalisé** Gutenberg :

```html
<iframe src="https://lesgitesdecartier.be/reserver/pre-more/?lang=fr"
        style="width:100%;height:1400px;border:0;max-width:1100px;margin:0 auto;display:block;"
        loading="lazy" title="Réservation"></iframe>
```

## Notes

- Pour le Pré Moré, préférer `/reserver/pre-more/` (le domaine est fixé par la
  page) ; l'ancienne adresse `/book/?property=pre-more` continue de fonctionner.
- L'URL de base (`$base`) est passée sur le domaine définitif le 01/11/2026 ;
  l'ancienne adresse sslip.io reste servie par Caddy.
- ⚠️ Le Caddyfile du serveur ne doit PAS poser `X-Frame-Options` : il
  écraserait la règle fine de l'application (`DENY` partout, rien sur
  `/book/`). C'est l'app qui décide, pas le proxy.
- Les paramètres du deep-link (`checkin`, `checkout`, `adults`, `children`,
  `unit`) passent tels quels : on peut les ajouter à l'attribut `src`.
- Le tunnel fait ses appels vers `/api/public/*` en relatif : l'iframe n'a
  besoin d'aucune configuration CORS.
- La hauteur est fixe (1400–1600 px recommandés) : le tunnel est conçu pour
  une page autonome et n'émet pas de message `postMessage` de redimensionnement.
