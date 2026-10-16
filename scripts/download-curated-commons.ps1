$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$imageDir = Join-Path $root 'images/products'
New-Item -ItemType Directory -Force -Path $imageDir | Out-Null

$items = @(
  @{ id='red-pepper'; title='File:Fresh red chilli.jpg' },
  @{ id='small-pepper'; title='File:DSC 9978 A vibrant pile of fresh red and green chili peppers ready to add a spicy kick to any dish.jpg' },
  @{ id='capsicum'; title='File:Freshly harvested red bell pepper.jpg' },
  @{ id='coriander'; title='File:A scene of Coriander leaves.JPG' },
  @{ id='lime-leaves'; title='File:C hystrix kaffir lime leaves.jpg' },
  @{ id='galangal'; title='File:Galangal.jpg' },
  @{ id='turmeric'; title='File:Turmeric rhizomes.jpg' },
  @{ id='ginger'; title='File:Fresh ginger (20240131).jpg' },
  @{ id='fuzhou-eggplant'; title='File:3 x Small eggplant 2017 A3.jpg' },
  @{ id='bitter-gourd'; title='File:Bitter Gourd.JPG' },
  @{ id='di-wen'; title='File:Cucumber fresh from harvest.jpg' },
  @{ id='tomato'; title='File:Ripe tomatoes.jpg' },
  @{ id='cabbage'; title='File:Green cabbage.jpg' },
  @{ id='winter-melon'; title='File:Winter melon.jpg' },
  @{ id='green-cauliflower'; title='File:Broccoli.jpg' },
  @{ id='spinach'; title='File:Fresh Spinach leaves.jpg' },
  @{ id='corn'; title='File:Corn On The Cobb From The Garden (120857005).jpeg' },
  @{ id='garlic'; title='File:Garlic Bulbs.jpg' },
  @{ id='pak-choi'; title='File:Bokchoy.jpg' }
  ,@{ id='taro'; title='File:Taro root.jpg' }
  ,@{ id='beetroot'; title='File:Beetroots in a basket.jpg' }
  ,@{ id='celery'; title='File:Celery (1).jpg' }
  ,@{ id='lotus-root'; title='File:Lotusroots.jpg' }
  ,@{ id='watercress'; title='File:Watercress (1).JPG' }
  ,@{ id='field-bean'; title='File:Fresh Green Beans (Unsplash).jpg' }
  ,@{ id='sweet-peas'; title='File:Snow peas - Pisum sativum.jpg' }
)

$titles = [uri]::EscapeDataString(($items.title -join '|'))
$api = "https://commons.wikimedia.org/w/api.php?action=query&titles=$titles&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=520&format=json"
$response = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent'='MarketStallSite/1.0 (image credits included)' } -TimeoutSec 40
$pagesByTitle = @{}
$response.query.pages.PSObject.Properties.Value | ForEach-Object { $pagesByTitle[$_.title] = $_ }
$imageMap = [ordered]@{}
$credits = [System.Collections.Generic.List[string]]::new()
$credits.Add('# Product photo credits')
$credits.Add('Photos are sourced from Wikimedia Commons and resized to 520px wide for the catalog. Their individual reuse licenses are listed below.')
$credits.Add('')

foreach ($item in $items) {
  $page = $pagesByTitle[$item.title]
  if (!$page -or !$page.imageinfo) { Write-Output "MISSING $($item.id): $($item.title)"; continue }
  $info = $page.imageinfo[0]
  $meta = $info.extmetadata
  $fileName = "$($item.id).jpg"
  Invoke-WebRequest -Uri $info.thumburl -OutFile (Join-Path $imageDir $fileName) -Headers @{ 'User-Agent'='MarketStallSite/1.0' } -TimeoutSec 40
  $imageMap[$item.id] = "images/products/$fileName"
  $license = [System.Net.WebUtility]::HtmlDecode($meta.LicenseShortName.value)
  $licenseUrl = $meta.LicenseUrl.value
  $artist = [System.Net.WebUtility]::HtmlDecode(($meta.Artist.value -replace '<[^>]+>', ' ')).Trim()
  if (!$artist) { $artist = 'Author listed on Wikimedia Commons' }
  $licenseText = if ($licenseUrl) { "[$license]($licenseUrl)" } else { $license }
  $imagePage = $info.descriptionurl
  $credits.Add("- **$($page.title -replace '^File:', '')** by $artist · $licenseText · [Source]($imagePage). Thumbnail resized for the website.")
  Write-Output "OK $($item.id) $license"
}

@('window.PRODUCT_IMAGES = ' + ($imageMap | ConvertTo-Json -Depth 4) + ';') | Set-Content -Path (Join-Path $root 'product-images.js') -Encoding utf8
$credits | Set-Content -Path (Join-Path $root 'IMAGE-CREDITS.md') -Encoding utf8
