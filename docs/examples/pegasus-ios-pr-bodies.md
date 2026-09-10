# Worked examples — example-app PR bodies

The canonical skeleton, used verbatim by 51 of the 78 most recent merged PRs that have
a body:

```
## Summary
---
## Screenshots / Screen Recordings
---
## What to Test
---
## Issues Addressed
---
## Analysis JIRA Issue
```

Eleven of those 78 omit **What to Test**. That is the gap shipkit closes.

These three examples span the change shapes the repository actually sees: a small
behavioural fix, a UI regression fix, and a large removal. Each is a real change from
this repository, so the reasoning can be checked against the diff.

---

## What a good fill does

| Section | Does | Does not |
|---|---|---|
| Summary | States what was wrong, what changed, and why this approach | Restate the diff, or list files |
| Screenshots | Shows before/after, or says plainly why there is nothing to show | Sit empty with the placeholder comment still in it |
| What to Test | Gives a QA person steps they can follow without reading the code, plus the regressions this change could plausibly cause | Say "test the payment screen" |
| Issues Addressed | Links at Story/Bug level — the parent when the title carries a subtask, the title's own key when it is already a Story or Bug | Link a Development subtask, or invent a neighbouring key |

---

# Example 1 — Small behavioural fix

*Basis: `[ABC-31087] fix(invoice): default citizenship from passenger info` — one file,
+17/−2.*

## Summary

Payment → Fatura Ekle ekranında uyruk, yolcu kim olursa olsun her zaman **T.C.
Vatandaşı** olarak geliyordu. Yabancı uyruklu yolcuyla ilerleyen kullanıcı, TCKN alanı
açık geldiği için ya alanı elle değiştirmek zorunda kalıyor ya da farkında olmadan
hatalı fatura bilgisi gönderiyordu.

Uyruk artık yolcunun `nationalId` alanından türetiliyor: dolu ise T.C. Vatandaşı (TCKN
görünür), boş ise Yabancı Uyruklu (TCKN gizli). Bu, uygulamanın kendi konvansiyonuyla
(`PassengerInfoViewModel`) ve Android'in davranışıyla aynı hizada. `clearFields()` de
sabit `.turkish` yerine aynı türetilmiş değere dönüyor.

Türetilen değer `super.init()` çağrısından sonra atanıyor; computed property,
initializer henüz 1. fazdayken okunamıyor.

**Değişen dosya:** `Sources/Scenes/Payment/Invoice/PaymentAddInvoiceViewModel.swift`

---

## Screenshots / Screen Recordings

| Öncesi | Sonrası |
|---|---|
| _TCKN'siz yolcuda bile T.C. Vatandaşı seçili_ | _Yabancı Uyruklu seçili, TCKN alanı gizli_ |

---

## What to Test

**Ekran:** Payment → Fatura Ekle → Bireysel

- TCKN bilgisi **olan** yolcuyla gir → uyruk **T.C. Vatandaşı** gelmeli, TCKN alanı görünür olmalı.
- TCKN bilgisi **olmayan** yolcuyla gir → uyruk **Yabancı Uyruklu** gelmeli, TCKN alanı gizli olmalı.
- Fatura tipini **Kurumsal**'a alıp tekrar **Bireysel**'e dön → uyruk yine yolcuya göre gelmeli, sabit T.C. Vatandaşı'na düşmemeli.
- Uyruğu elle değiştir → seçim korunmalı, ekran her açılışta sıfırlanmamalı.

**Regresyon:**
- TCKN yalnızca Bireysel + T.C. Vatandaşı seçiliyken gönderilmeli.
- Kurumsal fatura akışı (Firma adı / Vergi no / Vergi dairesi) etkilenmemeli.

---

## Issues Addressed

- [ABC-31086](https://jira.example.com/browse/ABC-31086)

---

## Analysis JIRA Issue

> ⚠️ This section is **auto-populated by CI**.
> No manual action is required.

---
---

# Example 2 — UI regression fix

*Basis: `fix(floating-field): restore the sliding label and its tap-through`.*

## Summary

Brand Identity geçişinde `PGSFloatingFieldChrome`'un label'ı iki ayrı `Text`'e
bölünmüştü: kutunun üstünde caption, input satırında resting label. Bu, merge edilmiş
`58696b888f` ("Match Figma icon/label behavior") commit'ini geri alıyordu ve iki
soruna yol açıyordu:

1. **Kayma animasyonu kayboldu.** İki ayrı `Text` iki ayrı view identity demek; SwiftUI
   pozisyon interpolasyonu yapamadığı için `.animation(value: isLabelFloating)` artık
   kaymayı değil layout insertion'ını animate ediyordu — büyük label fade-out, küçük
   caption fade-in.
2. **Label'a dokunmak focus vermiyordu.** Floating caption'da `.allowsHitTesting(false)`
   yoktu; `Text` varsayılan olarak hit-testable olduğu için arkadaki tap katmanını
   yutuyordu. Dolu ama odaksız alanlarda ve placeholder'lı alanda (son geçerlilik
   tarihi) label'a dokunmak çalışmıyordu.

Tek kalıcı `Text` + overlay alignment desenine dönüldü. Caption satırı **koşulsuz**
rezerve ediliyor: böylece kutu tek yükseklikte kalıyor ve label yüzerken trailing
kontroller kaymıyor. Overlay, kutunun tamamı yerine alanın kendi kolonuyla sınırlı, bu
yüzden uzun label accessory'nin altına giremiyor.

Yan fayda: iki durumun içerik yüksekliği artık birebir aynı olduğu için büyük punto
ayarlarında resting/floating yüksekliklerinin ayrışması yapısal olarak imkânsız.

---

## Screenshots / Screen Recordings

| Öncesi | Sonrası |
|---|---|
| _Focus'ta label fade ile yer değiştiriyor_ | _Label yukarı süzülüyor_ |

Ekran kaydı: kart numarası alanına odaklan → label kayarak yukarı çıkmalı, sıçramamalı.

---

## What to Test

**Ekran:** Ödeme → Kredi Kartı ile Öde

**Animasyon**
- Boş bir alana dokun → label **kayarak** yukarı çıkmalı; fade/zıplama olmamalı.
- Odağı kaldır (alan boşken) → label kayarak ortaya dönmeli.

**Tap-to-focus**
- Alanı doldur, odağı kaldır → küçülmüş label'ın **üstüne** dokun → alan odaklanmalı.
- Son Geçerlilik Tarihi alanında (boşken bile label yukarıda) label'a dokun → odaklanmalı.

**Yerleşim**
- Odak değişirken kutu yüksekliği ve sağdaki ikonlar (tara / CVV bilgi / temizle) **kımıldamamalı**.
- Uzun label'lı bir alanda label sağdaki ikonun altına girmemeli, üç nokta ile kesilmeli.

**Regresyon**
- Temizle butonu yalnızca odaklıyken ve alanda metin varken görünmeli.
- Temizle + accessory birlikte görünürken aradaki ayraç çıkmalı; accessory yoksa ayraç **çıkmamalı**.
- Hata durumunda kırmızı kenarlık ve alt mesaj bozulmamalı.
- Şifre alanı (`PGSFloatingPasswordField`) göz ikonu davranışı etkilenmemeli.

---

## Issues Addressed

- [ABC-31444](https://jira.example.com/browse/ABC-31444)

---

## Analysis JIRA Issue

> ⚠️ This section is **auto-populated by CI**.
> No manual action is required.

---
---

# Example 3 — Large removal

*Basis: `[ABC-31789] feat(remove-non-booking-ife): remove non-booking ife sales entry
points` — 46 files, +15/−3924.*

## Summary

IFE (uçak içi eğlence) satışı yalnızca booking akışında kalacak şekilde sadeleştirildi.
Booking dışındaki satış giriş noktaları ve eski IFE seçim ekranı kaldırıldı:

- Ana menü / Search PNR üzerinden IFE satın alma girişi
- Travel Assistant üzerinden IFE satın alma girişi
- Legacy `IFESelection` ekranı ve ona giden router yolları

**Kaldırılmayanlar** — bunlar canlı akışın parçası olduğu için korundu:
- Booking içindeki IFE satışı (yeni Meal & Other SSR ekranı)
- Reissue akışında IFE uygunluk kontrolü (`SelectedFlightsIfeAvailabilityRequest`)
- `PGSSsrType.ife` ve ona bağlı analytics/özet/checkin kodu

Net etki: 46 dosya, ~3.900 satır silme.

---

## Screenshots / Screen Recordings

Görsel bir ekleme yok; değişiklik tamamen kaldırma. Doğrulama, aşağıdaki giriş
noktalarının **artık görünmemesi** ve korunan akışların bozulmaması üzerinden yapılmalı.

---

## What to Test

**Kaldırıldığını doğrula**
- Ana menü → Ek Hizmetler → IFE girişi görünmemeli.
- PNR sorgulama sonrası ek hizmetler listesinde IFE seçeneği olmamalı.
- Travel Assistant → uçuş detayında IFE satın alma girişi olmamalı.
- Bu ekranlarda IFE ile ilgili bir buton kalmışsa dokunulduğunda **hiçbir şey olmamalı**, crash olmamalı.

**Bozulmadığını doğrula — kritik**
- **Booking akışı:** Uçuş seç → yolcu → koltuk/yemek/bagaj → Meal & Other SSR ekranında **IFE kartı görünmeli**, tıklanınca detay/satın alma açılmalı, sepete eklenip ödeme tamamlanabilmeli.
- **Reissue:** IFE eklenmiş bir PNR ile uçuş değişikliği yap → yeni uçuş seçiminden sonra crash olmadan özet ekranına geçmeli.
- **Checkin & özet:** IFE satın alınmış bir PNR'da ödeme özeti, checkin özeti ve Travel Assistant uçuş detayında IFE bilgisi doğru görünmeli.
- **Offline:** Daha önce alınmış IFE kodu Travel Assistant'ta çevrimdışı görüntülenebilmeli.

**Regresyon**
- Diğer SSR'lar (koltuk, yemek, bagaj, flex, sigorta) booking ve checkin akışlarında etkilenmemeli.

---

## Issues Addressed

- [ABC-31789](https://jira.example.com/browse/ABC-31789)

---

## Analysis JIRA Issue

> ⚠️ This section is **auto-populated by CI**.
> No manual action is required.
