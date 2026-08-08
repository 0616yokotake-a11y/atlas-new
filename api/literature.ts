type LiteratureGoal = '筋肥大' | 'ダイエット'

type TopicConfig = {
  title: string
  query: string
}

type PubMedSummary = {
  uid: string
  title: string
  fulljournalname: string
  pubdate: string
  elocationid?: string
}

function getGoalFromQuery(goalParam: unknown): LiteratureGoal {
  return goalParam === 'ダイエット' ? 'ダイエット' : '筋肥大'
}

function getTopics(goal: LiteratureGoal): TopicConfig[] {
  if (goal === 'ダイエット') {
    return [
      {
        title: '減量中の筋量維持',
        query:
          '("resistance training"[Title/Abstract] OR "strength training"[Title/Abstract]) AND ("weight loss"[Title/Abstract] OR "energy deficit"[Title/Abstract]) AND humans[Filter]',
      },
      {
        title: 'たんぱく質と除脂肪量',
        query:
          '("protein"[Title/Abstract] AND "resistance training"[Title/Abstract]) AND ("lean mass"[Title/Abstract] OR hypertrophy[Title/Abstract]) AND humans[Filter]',
      },
      {
        title: '休憩と密度',
        query:
          '("rest interval"[Title/Abstract] OR "training density"[Title/Abstract]) AND "resistance training"[Title/Abstract] AND humans[Filter]',
      },
      {
        title: '有酸素併用と体組成',
        query:
          '("concurrent training"[Title/Abstract] OR "aerobic exercise"[Title/Abstract]) AND ("body composition"[Title/Abstract] OR "fat loss"[Title/Abstract]) AND humans[Filter]',
      },
    ]
  }

  return [
    {
      title: '筋肥大のボリューム',
      query:
        '"resistance training"[Title/Abstract] AND hypertrophy[Title/Abstract] AND ("training volume"[Title/Abstract] OR volume[Title/Abstract]) AND humans[Filter]',
    },
    {
      title: '頻度と成長',
      query:
        '"resistance training"[Title/Abstract] AND frequency[Title/Abstract] AND hypertrophy[Title/Abstract] AND humans[Filter]',
    },
    {
      title: '休憩と総負荷',
      query:
        '("rest interval"[Title/Abstract] OR "interset rest"[Title/Abstract]) AND "resistance training"[Title/Abstract] AND hypertrophy[Title/Abstract] AND humans[Filter]',
    },
    {
      title: '進捗モデル',
      query:
        '"resistance training"[Title/Abstract] AND progression[Title/Abstract] AND "healthy adults"[Title/Abstract] AND humans[Filter]',
    },
  ]
}

async function fetchPubMedIds(query: string) {
  const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi')
  url.searchParams.set('db', 'pubmed')
  url.searchParams.set('retmode', 'json')
  url.searchParams.set('sort', 'pub date')
  url.searchParams.set('retmax', '3')
  url.searchParams.set('term', query)
  url.searchParams.set('tool', 'Atlas')

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`PubMed search failed: ${response.status}`)
  }

  const payload = (await response.json()) as {
    esearchresult?: {
      idlist?: string[]
    }
  }

  return payload.esearchresult?.idlist ?? []
}

async function fetchPubMedSummaries(ids: string[]) {
  if (ids.length === 0) {
    return []
  }

  const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi')
  url.searchParams.set('db', 'pubmed')
  url.searchParams.set('retmode', 'json')
  url.searchParams.set('id', ids.join(','))
  url.searchParams.set('tool', 'Atlas')

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`PubMed summary failed: ${response.status}`)
  }

  const payload = (await response.json()) as {
    result?: {
      uids?: string[]
      [key: string]: PubMedSummary | string[] | undefined
    }
  }

  const uids = payload.result?.uids ?? []
  return uids
    .map((uid) => {
      const summary = payload.result?.[uid] as PubMedSummary | undefined
      if (!summary) {
        return null
      }

      return {
        pmid: uid,
        title: summary.title,
        journal: summary.fulljournalname || 'PubMed',
        pubDate: summary.pubdate || 'n.d.',
        url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
        snippet: summary.elocationid ? `DOI / 巻号: ${summary.elocationid}` : `PMID: ${uid}`,
      }
    })
    .filter((item): item is { pmid: string; title: string; journal: string; pubDate: string; url: string; snippet: string } => Boolean(item))
}

export default async function handler(req: any, res: any) {
  const goal = getGoalFromQuery(req?.query?.goal)
  const topics = getTopics(goal)

  try {
    const sections = []
    for (const topic of topics) {
      const ids = await fetchPubMedIds(topic.query)
      await sleep(350)
      const articles = await fetchPubMedSummaries(ids)
      sections.push({
        title: topic.title,
        query: topic.query,
        articles,
      })
      await sleep(350)
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.status(200).json({
      goal,
      updatedAt: new Date().toISOString(),
      sections,
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }

  function sleep(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}
