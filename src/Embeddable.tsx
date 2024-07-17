import VueWrapper from "./VueWrapper"

/**
 *
 */
export default function(props) {
    const {react} = props
    let testing = react.useRef('')

    react.useEffect(()=> {
        fetch("/").then(async resp => {
            testing.current = await resp.text()
        })
    },[])

    const referenceProps = {text: props.url, limit: "1", interactive: true}
	return (
        <VueWrapper componentProps={referenceProps} />
    )
}
