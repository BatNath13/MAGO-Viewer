BEGIN;

-- La nomenclature du nuage extérieur utilisé par MAGO est : 4 = végétation.
UPDATE mago_class
   SET display_name = 'Végétation'
 WHERE label = 4
   AND display_name IS DISTINCT FROM 'Végétation';

-- La classe 5 ne doit plus être présentée comme végétation tant que son sens
-- réel n'est pas défini dans la nomenclature source.
UPDATE mago_class
   SET display_name = 'Classe 5'
 WHERE label = 5
   AND lower(display_name) IN (lower('Végétation'), 'vegetation');

COMMIT;

SELECT label, class_key, display_name
  FROM mago_class
 WHERE label IN (4, 5, 66)
 ORDER BY label;
